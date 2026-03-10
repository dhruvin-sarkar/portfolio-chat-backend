const express = require("express");
const cors = require("cors");
const http = require("http");
const { WebSocketServer } = require("ws");
const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");
require("dotenv").config();

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 4000;

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: [
    "http://localhost:3000",
    "http://localhost:5173",
    "https://dhruvin-sarkar-dev.vercel.app",
    "https://dhruvin-sarkar.dev",
    "https://www.dhruvin-sarkar.dev"
  ]
}));
app.use(express.json());

// ─── MONGODB ──────────────────────────────────────────────────────────────────
mongoose.connect(process.env.MONGO_URI).then(() => {
  console.log("MongoDB connected ✅");
}).catch((err) => console.error("MongoDB error:", err));

const messageSchema = new mongoose.Schema({
  sessionId: String,
  username: String,
  text: String,
  timestamp: { type: Date, default: Date.now, expires: 86400 }, // auto-delete after 24h
});
const Message = mongoose.model("Message", messageSchema);

// ─── WORD FILTER ──────────────────────────────────────────────────────────────
const BANNED_WORDS = ["spam", "scam"]; // add more as needed
const containsBannedWord = (text) =>
  BANNED_WORDS.some((w) => text.toLowerCase().includes(w));

// ─── SESSION KEYS ─────────────────────────────────────────────────────────────
// Each session gets a UUID key that expires after 24h
const sessions = new Map(); // sessionId -> { key, expires }

const createSession = () => {
  const sessionId = uuidv4();
  const key = uuidv4();
  const expires = Date.now() + 24 * 60 * 60 * 1000;
  sessions.set(sessionId, { key, expires });
  return { sessionId, key };
};

const validateSession = (sessionId, key) => {
  const session = sessions.get(sessionId);
  if (!session) return false;
  if (Date.now() > session.expires) {
    sessions.delete(sessionId);
    return false;
  }
  return session.key === key;
};

// Clean up expired sessions every hour
setInterval(() => {
  for (const [id, s] of sessions.entries()) {
    if (Date.now() > s.expires) sessions.delete(id);
  }
}, 60 * 60 * 1000);

// ─── REST ENDPOINTS ───────────────────────────────────────────────────────────

// Get a session key
app.post("/chat/session", (req, res) => {
  const session = createSession();
  res.json(session);
});

// Get recent messages
app.get("/chat/getchat/", async (req, res) => {
  try {
    const messages = await Message.find()
      .sort({ timestamp: -1 })
      .limit(50)
      .lean();
    res.json(messages.reverse());
  } catch (err) {
    console.error("Get chat error:", err.message);
    res.status(500).json({ error: "Failed to fetch messages" });
  }
});

// Health check
app.get("/", (req, res) => res.send("Chat backend running ✅"));

// ─── WEBSOCKET ────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });
const clients = new Set();

// Rate limiting: max 5 messages per 10 seconds per connection
const rateLimits = new Map();
const isRateLimited = (ws) => {
  const now = Date.now();
  const limit = rateLimits.get(ws) || { count: 0, windowStart: now };
  if (now - limit.windowStart > 10000) {
    rateLimits.set(ws, { count: 1, windowStart: now });
    return false;
  }
  if (limit.count >= 5) return true;
  limit.count++;
  rateLimits.set(ws, limit);
  return false;
};

const broadcast = (data, excludeWs = null) => {
  const payload = JSON.stringify(data);
  for (const client of clients) {
    if (client !== excludeWs && client.readyState === 1) {
      client.send(payload);
    }
  }
};

wss.on("connection", (ws) => {
  clients.add(ws);
  console.log(`Client connected. Total: ${clients.size}`);

  ws.on("message", async (raw) => {
    try {
      const data = JSON.parse(raw.toString());

      // ── NUDGE ──────────────────────────────────────────────────────────────
      if (data.type === "nudge") {
        broadcast({ type: "nudge", username: data.username }, ws);
        return;
      }

      // ── CHAT MESSAGE ───────────────────────────────────────────────────────
      if (data.type === "message") {
        // Validate session
        if (!validateSession(data.sessionId, data.key)) {
          ws.send(JSON.stringify({ type: "error", message: "Invalid session" }));
          return;
        }

        // Rate limit
        if (isRateLimited(ws)) {
          ws.send(JSON.stringify({ type: "error", message: "Slow down!" }));
          return;
        }

        // Word filter
        if (containsBannedWord(data.text)) {
          ws.send(JSON.stringify({ type: "error", message: "Message blocked" }));
          return;
        }

        // Save to DB
        const msg = await Message.create({
          sessionId: data.sessionId,
          username: data.username || "Anonymous",
          text: data.text.slice(0, 500), // max 500 chars
        });

        const outgoing = {
          type: "message",
          _id: msg._id,
          username: msg.username,
          text: msg.text,
          timestamp: msg.timestamp,
        };

        // Send to everyone including sender
        broadcast(outgoing);
        ws.send(JSON.stringify(outgoing));
        return;
      }
    } catch (err) {
      console.error("WS message error:", err.message);
    }
  });

  ws.on("close", () => {
    clients.delete(ws);
    rateLimits.delete(ws);
    console.log(`Client disconnected. Total: ${clients.size}`);
  });
});

server.listen(PORT, () => console.log(`Chat backend listening on port ${PORT}`));
