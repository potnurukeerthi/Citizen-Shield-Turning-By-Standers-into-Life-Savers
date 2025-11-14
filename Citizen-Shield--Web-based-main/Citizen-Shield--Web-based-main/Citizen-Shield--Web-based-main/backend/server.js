// Imports
// ----------------------
const express = require("express");
const nodemailer = require("nodemailer");
const cors = require("cors");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
require("dotenv").config();

// ----------------------
// App + Server setup
// ----------------------
const app = express();
const server = http.createServer(app);
// NOTE: We no longer need the userSockets object, as we use Socket.IO Rooms instead.
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(express.json());

// Serve frontend
app.use(express.static(path.join(__dirname, "../frontend")));
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "../frontend/landing.html"))
);

// ----------------------
// In-memory storage
// ----------------------
// { username: { lat, lon, sosActive, emergencyEmail, emergencyNumber } }
let userLocations = {}; 


// ----------------------
// Helper function for distance calculation
// ----------------------
// Haversine formula to calculate distance (in km) between two lat/lon points
function getDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Radius of Earth in km
  const dLat = (lat2 - lat1) * (Math.PI / 180);
  const dLon = (lon2 - lon1) * (Math.PI / 180);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) *
      Math.cos(lat2 * (Math.PI / 180)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // Distance in km
}

// ----------------------
// User Registration
// ----------------------
app.post("/register", (req, res) => {
  const { username, emergencyEmail, emergencyNumber } = req.body;
  if (!username || !emergencyEmail || !emergencyNumber)
    return res.status(400).json({ success: false, message: "Missing fields" });

  if (!userLocations[username]) userLocations[username] = {};
  userLocations[username].emergencyEmail = emergencyEmail;
  userLocations[username].emergencyNumber = emergencyNumber;

  console.log(`✅ Registered user: ${username}`);
  res.json({ success: true, message: "Registered successfully" });
});

// ----------------------
// Update location
// ----------------------
app.post("/update-location", (req, res) => {
  const { username, lat, lon } = req.body;
  if (!username || !lat || !lon)
    return res.status(400).send("Missing fields");

  if (!userLocations[username]) userLocations[username] = {};
  userLocations[username].lat = parseFloat(lat); // Ensure location is stored as float
  userLocations[username].lon = parseFloat(lon); // Ensure location is stored as float
  userLocations[username].sosActive = userLocations[username].sosActive || false;

  res.send("Location updated");
});

// ----------------------
// Send SOS (Email + Notify nearby users)
// ----------------------
app.post("/send-sos", async (req, res) => {
  const { username, location } = req.body;
  if (!username || !location)
    return res.status(400).send("Missing fields");

  if (!userLocations[username] || !userLocations[username].lat || !userLocations[username].lon)
      return res.status(400).send("User location data missing to trigger SOS");

  userLocations[username].sosActive = true;
  const { emergencyEmail, emergencyNumber } = userLocations[username];

  // ------------------ Send Email ------------------
  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 587,
      secure: false,
      auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
      tls: { rejectUnauthorized: false },
    });

    const mailOptions = {
      from: `"Citizen Shield - ${username}" <${process.env.EMAIL_USER}>`,
      to: emergencyEmail,
      subject: "🚨 SOS Alert from Citizen Shield",
      text: `User ${username} is in danger!\nLocation: ${location}\nEmergency Number: ${emergencyNumber}`,
    };

    await transporter.sendMail(mailOptions);
    console.log(`✅ Email sent to ${emergencyEmail}`);
  } catch (err) {
    console.error("❌ Error sending email:", err.message);
  }

  // ------------------ Notify nearby users (FIXED LOGIC) ------------------
  const NEARBY_RADIUS_KM = 5; 
  const { lat: victimLat, lon: victimLon } = userLocations[username];

  Object.keys(userLocations).forEach((u) => {
    // 1. Don't notify self
    if (u === username) return; 

    const helper = userLocations[u];
    
    // 2. Check if the helper has a location
    if (helper.lat && helper.lon) {
      const distance = getDistance(victimLat, victimLon, helper.lat, helper.lon);
      
      // 3. Check if the helper is within the nearby radius
      if (distance <= NEARBY_RADIUS_KM) {
        // 4. Send alert to the helper's room (all their connected tabs)
        // Note: io.to(u) targets the room named 'u'
        io.to(u).emit("sos-alert", { username, location }); 
        console.log(`📡 Notified nearby user ${u} (Distance: ${distance.toFixed(2)} km)`);
      }
    }
  });
  // ------------------ END FIXED NOTIFY ------------------

  res.send("SOS triggered (email + socket notifications, SMS via frontend)");
});

// ----------------------
// Nearby users
// ----------------------
app.get("/nearby-users", (req, res) => {
  // Client MUST send their location now to filter
  const { username, lat, lon } = req.query;

  if (!username || !lat || !lon) {
    return res.status(400).json({ success: false, message: "Missing username or location for filtering" });
  }

  const userLat = parseFloat(lat);
  const userLon = parseFloat(lon);
  const NEARBY_RADIUS_KM = 5; // Define your "nearby" range (e.g., 5 km)

  const nearbyUsers = Object.keys(userLocations)
    .filter((u) => u !== username) // Don't include self
    .filter((u) => {
      const otherUser = userLocations[u];
      // Check if the other user has valid location data
      if (otherUser.lat && otherUser.lon) {
        // Calculate distance and filter
        const distance = getDistance(userLat, userLon, otherUser.lat, otherUser.lon);
        return distance <= NEARBY_RADIUS_KM;
      }
      return false; // Exclude users with no location
    })
    .map((u) => ({
      username: u,
      lat: userLocations[u].lat,
      lon: userLocations[u].lon,
      sosActive: userLocations[u].sosActive,
    }));
    
  res.json(nearbyUsers);
});

// ----------------------
// Socket.IO (UPDATED to use Rooms)
// ----------------------
io.on("connection", (socket) => {
  console.log("🔗 User connected:", socket.id);

  socket.on("register-user", (username) => {
    // 1. Join a room named after the username (Handles multiple tabs)
    socket.join(username); 
    // 2. Attach the username to the socket object for easy access
    socket.data.username = username;
    
    console.log(`✅ Registered user via socket and joined room: ${username}`);

    // Notify other users about new online user (no distance filter here, frontend filters what it displays)
    if(userLocations[username] && userLocations[username].lat && userLocations[username].lon){
      // This part still broadcasts to all sockets, which is fine for updating the map data
      io.sockets.emit("user-online", {
        username,
        lat: userLocations[username].lat,
        lon: userLocations[username].lon,
        sosActive: userLocations[username].sosActive
      });
    }
  });

  socket.on("accept-sos", ({ saver, victim }) => {
    if (userLocations[victim]) {
        
      // Send victim location to ALL sockets (tabs) connected by the 'saver' user
      // Using io.to(saver) targets the Room named 'saver'
      io.to(saver).emit("sos-accepted", { 
        saver,
        victim,
        location: userLocations[victim],
      });

      // Notify ALL sockets (tabs) connected by the 'victim' user who accepted
      // Using io.to(victim) targets the Room named 'victim'
      io.to(victim).emit("helper-accepted", { saver }); 

      console.log(`${saver} accepted SOS of ${victim}`);
    }
  });

  socket.on("decline-sos", ({ saver, victim }) => {
    // Decline message is still logged but doesn't send a notification to the victim
    console.log(`${saver} declined SOS of ${victim}`);
  });

  socket.on("disconnect", () => {
    // The socket is automatically removed from all rooms it joined (including its username room).
    // The complex cleanup loop for userSockets is no longer needed.
    console.log(`❌ User disconnected: ${socket.id}`);
  });
});

// ----------------------
// Start Server
// ----------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () =>
  console.log(`🚀 Citizen Shield backend running on port ${PORT}`)
);