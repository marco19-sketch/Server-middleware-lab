// ============================================
// SERVER.JS - Express server with MariaDB connection and middleware
// This is the main entry point for your backend API
// ============================================

// Import required dependencies
import express from "express"; // Express framework - creates the server
import * as mariadb from "mariadb"; // MariaDB driver - connects to database (using * as because no default export)
import cors from "cors"; // CORS middleware - allows requests from different origins
import dotenv from "dotenv"; // Environment variables - loads config from .env file

// ============================================
// ENVIRONMENT CONFIGURATION
// ============================================

// Load environment variables from .env file into process.env
// This makes DB credentials and other config available throughout the app
dotenv.config();

// ============================================
// EXPRESS APP INITIALIZATION
// ============================================

// Create the Express application instance
// This 'app' object is your entire server - everything attaches to it
const app = express();

// ============================================
// MIDDLEWARE SECTION - ALL PART OF THE SERVER
// These functions process EVERY request that comes to your server
// They run in the order they are defined (top to bottom)
// ============================================

// 1. Logger Middleware - Logs every request for debugging and monitoring
app.use((req, res, next) => {
  const timestamp = new Date().toISOString(); // Create timestamp for this request

  // Log incoming request details
  console.log(`\n📨 [${timestamp}] ${req.method} ${req.url}`);
  console.log(`   Headers:`, req.headers["content-type"] || "no content-type");

  // Set up event listener for when response is sent
  // This runs AFTER the route handler sends the response
  res.on("finish", () => {
    console.log(
      `📤 [${timestamp}] ${req.method} ${req.url} - ${res.statusCode}`,
    );
  });

  next(); // CRITICAL: Pass control to the next middleware in the pipeline
});

// 2. CORS Middleware - Controls which domains can access your API
// Without this, browsers would block requests from different origins
app.use(
  cors({
    origin: "*", // WARNING: In production, specify your actual frontend URL (e.g., 'http://myapp.com')
    methods: ["GET", "POST", "PUT", "DELETE"], // Allowed HTTP methods
    allowedHeaders: ["Content-Type", "Authorization"], // Allowed headers in requests
  }),
);

// 3. JSON Parser Middleware - Automatically parses JSON request bodies
// Without this, req.body would be undefined for JSON requests
app.use(express.json());

// 4. URL Encoded Parser - Parses form data from HTML forms
// extended: true allows parsing of nested objects
app.use(express.urlencoded({ extended: true }));

// 5. Request Timer Middleware - Adds timing info to every request
// This attaches a property to the req object that routes can use
app.use((req, res, next) => {
  req.requestTime = Date.now(); // Store start time in milliseconds
  next();
});

// ============================================
// DATABASE CONNECTION POOL
// Creates a pool of reusable database connections
// Better than creating new connection for every request
// ============================================

const pool = mariadb.createPool({
  host: process.env.DB_HOST || "localhost", // Database server address
  port: process.env.DB_PORT || 3306, // MariaDB default port
  user: process.env.DB_USER || "root", // Database username
  password: process.env.DB_PASSWORD || "", // Database password (set in .env!)
  database: process.env.DB_NAME || "test", // Database name to use
  connectionLimit: 5, // Maximum concurrent connections
  acquireTimeout: 30000, // Timeout for getting connection (ms)
});

// ============================================
// DATABASE CONNECTION TEST
// Verifies we can connect to MariaDB on startup
// Creates the products table if it doesn't exist
// ============================================

async function testConnection() {
  let conn; // Declare connection variable
  try {
    // Attempt to get a connection from the pool
    conn = await pool.getConnection();
    console.log("✅ Connected to MariaDB successfully!");

    // Create products table if it doesn't exist
    // This is automatic schema setup - no manual creation needed
    await conn.query(`
      CREATE TABLE IF NOT EXISTS products (
        id INT AUTO_INCREMENT PRIMARY KEY,        -- Unique identifier for each product
        name VARCHAR(255) NOT NULL,                -- Product name (required)
        price DECIMAL(10,2) NOT NULL,               -- Price with 2 decimal places (required)
        in_stock BOOLEAN DEFAULT true,              -- Stock status (defaults to true)
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP -- Auto-set creation time
      )
    `);
    console.log("✅ Products table ready");
  } catch (err) {
    // If connection fails, log error and exit - server can't run without DB
    console.error("❌ Database connection failed:", err.message);
    process.exit(1); // Exit with error code
  } finally {
    // ALWAYS release the connection back to the pool
    if (conn) conn.release();
  }
}

// Execute the connection test immediately
testConnection();

// ============================================
// DATABASE MIDDLEWARE
// Attaches the connection pool to every request
// This way, routes can access the database via req.db
// ============================================

app.use((req, res, next) => {
  req.db = pool; // Make pool available to all route handlers
  next();
});

// ============================================
// VALIDATION MIDDLEWARE
// Checks that product data meets requirements before saving to DB
// Prevents invalid data from reaching the database
// ============================================

const validateProduct = (req, res, next) => {
  const { name, price, in_stock } = req.body; // Destructure request body

  console.log("🔍 Validating product data...");

  const errors = []; // Collect all validation errors

  // Name validation
  if (!name) errors.push("Product name is required");
  if (name && name.length < 3)
    errors.push("Product name must be at least 3 characters");

  // Price validation
  if (!price && price !== 0) errors.push("Price is required");
  if (price && isNaN(parseFloat(price))) errors.push("Price must be a number");
  if (price && parseFloat(price) < 0) errors.push("Price cannot be negative");

  // If validation fails, send error response immediately
  // This SHORT-CIRCUITS the request - route handler never runs
  if (errors.length > 0) {
    console.log("❌ Validation failed:", errors);
    return res.status(400).json({
      error: "Validation failed",
      details: errors,
    });
  }

  // Convert price to number if it came as string (from forms)
  if (req.body.price) {
    req.body.price = parseFloat(req.body.price);
  }

  console.log("✅ Validation passed");
  next(); // All good, proceed to route handler
};

// ============================================
// AUTHENTICATION MIDDLEWARE
// Simple token-based auth for demo purposes
// In production, use JWT, OAuth, or proper authentication
// ============================================

const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization; // Get Authorization header

  // Check for valid token
  // For demo, we accept exactly "Bearer my-secret-token"
  if (!authHeader || authHeader !== "Bearer my-secret-token") {
    console.log("🔒 Authentication failed: Invalid or missing token");
    return res.status(401).json({
      error: "Unauthorized",
      message: "Valid authorization token required",
    });
  }

  console.log("🔒 Authentication successful");
  next(); // User authenticated, proceed
};

// ============================================
// ERROR HANDLING MIDDLEWARE
// Catches any errors passed via next(err)
// Must have 4 parameters to be recognized as error handler
// ============================================

const errorHandler = (err, req, res, next) => {
  console.error("🔥 Error:", err.stack); // Log full error stack for debugging

  // Handle specific database errors with appropriate HTTP status codes
  if (err.code === "ER_DUP_ENTRY") {
    return res.status(409).json({
      // 409 Conflict
      error: "Duplicate entry",
      message: "A record with this information already exists",
    });
  }

  if (err.code === "ECONNREFUSED") {
    return res.status(503).json({
      // 503 Service Unavailable
      error: "Database connection failed",
      message: "Unable to connect to database",
    });
  }

  // Default error response
  // In development, show actual error message; in production, hide details
  res.status(500).json({
    error: "Internal server error",
    message:
      process.env.NODE_ENV === "development"
        ? err.message
        : "Something went wrong",
  });
};

// ============================================
// ROUTES (with middleware chains)
// Each route can have multiple middleware functions
// They run in order before the final handler
// ============================================

// GET all products - PUBLIC ROUTE (no authentication needed)
app.get("/api/products", async (req, res, next) => {
  console.log("📦 Fetching all products...");

  let conn; // Declare connection variable
  try {
    // Get a connection from the pool
    conn = await req.db.getConnection();

    // Execute query to get all products, newest first
    const rows = await conn.query(
      "SELECT * FROM products ORDER BY created_at DESC",
    );

    console.log(`✅ Found ${rows.length} products`);

    // Send response with products and metadata
    res.json({
      success: true,
      count: rows.length,
      data: rows,
      responseTime: `${Date.now() - req.requestTime}ms`, // From timer middleware
    });
  } catch (err) {
    next(err); // Pass any errors to error handler
  } finally {
    // ALWAYS release connection back to pool
    if (conn) conn.release();
  }
});

// GET single product by ID - PUBLIC ROUTE
app.get("/api/products/:id", async (req, res, next) => {
  console.log(`📦 Fetching product ID: ${req.params.id}`);

  let conn;
  try {
    conn = await req.db.getConnection();

    // Parameterized query prevents SQL injection
    const rows = await conn.query("SELECT * FROM products WHERE id = ?", [
      req.params.id, // The ? is replaced with this value safely
    ]);

    // If no product found with that ID
    if (rows.length === 0) {
      return res.status(404).json({
        error: "Not found",
        message: `Product with ID ${req.params.id} not found`,
      });
    }

    console.log(`✅ Found product: ${rows[0].name}`);

    res.json({
      success: true,
      data: rows[0],
    });
  } catch (err) {
    next(err);
  } finally {
    if (conn) conn.release();
  }
});

// CREATE product - PROTECTED ROUTE (needs auth + validation)
app.post(
  "/api/products",
  authenticate, // First: Check authentication (if fails, stops here)
  validateProduct, // Second: Validate data (if fails, stops here)
  async (req, res, next) => {
    // Third: If all middleware passed, create product
    console.log("📦 Creating new product:", req.body);

    let conn;
    try {
      conn = await req.db.getConnection();

      // Insert new product with data from request body
      const result = await conn.query(
        "INSERT INTO products (name, price, in_stock) VALUES (?, ?, ?)",
        [
          req.body.name,
          req.body.price,
          req.body.in_stock !== undefined ? req.body.in_stock : true, // Default to true
        ],
      );

      // Fetch the newly created product to return it
      const newProduct = await conn.query(
        "SELECT * FROM products WHERE id = ?",
        [result.insertId], // insertId is auto-generated by database
      );

      console.log(`✅ Product created with ID: ${result.insertId}`);

      // 201 = Created (success with resource creation)
      res.status(201).json({
        success: true,
        message: "Product created successfully",
        data: newProduct[0],
      });
    } catch (err) {
      next(err);
    } finally {
      if (conn) conn.release();
    }
  },
);

// UPDATE product - PROTECTED ROUTE
app.put(
  "/api/products/:id",
  authenticate, // Check auth first
  validateProduct, // Validate new data
  async (req, res, next) => {
    console.log(`📦 Updating product ID: ${req.params.id}`);

    let conn;
    try {
      conn = await req.db.getConnection();

      // Check if product exists before updating
      const existing = await conn.query("SELECT * FROM products WHERE id = ?", [
        req.params.id,
      ]);

      if (existing.length === 0) {
        return res.status(404).json({
          error: "Not found",
          message: `Product with ID ${req.params.id} not found`,
        });
      }

      // Perform the update
      await conn.query(
        "UPDATE products SET name = ?, price = ?, in_stock = ? WHERE id = ?",
        [req.body.name, req.body.price, req.body.in_stock, req.params.id],
      );

      // Fetch updated product to return it
      const updated = await conn.query("SELECT * FROM products WHERE id = ?", [
        req.params.id,
      ]);

      console.log(`✅ Product updated: ${req.params.id}`);

      res.json({
        success: true,
        message: "Product updated successfully",
        data: updated[0],
      });
    } catch (err) {
      next(err);
    } finally {
      if (conn) conn.release();
    }
  },
);

// DELETE product - PROTECTED ROUTE
app.delete("/api/products/:id", authenticate, async (req, res, next) => {
  console.log(`📦 Deleting product ID: ${req.params.id}`);

  let conn;
  try {
    conn = await req.db.getConnection();

    // Check if product exists
    const existing = await conn.query("SELECT * FROM products WHERE id = ?", [
      req.params.id,
    ]);

    if (existing.length === 0) {
      return res.status(404).json({
        error: "Not found",
        message: `Product with ID ${req.params.id} not found`,
      });
    }

    // Delete the product
    await conn.query("DELETE FROM products WHERE id = ?", [req.params.id]);

    console.log(`✅ Product deleted: ${req.params.id}`);

    res.json({
      success: true,
      message: "Product deleted successfully",
    });
  } catch (err) {
    next(err);
  } finally {
    if (conn) conn.release();
  }
});

// Health check endpoint - PUBLIC ROUTE
// Useful for monitoring if server is alive
app.get("/api/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(), // How long server has been running (seconds)
    database: pool ? "connected" : "disconnected", // Check DB status
  });
});

// ============================================
// 404 HANDLER - Route not found
// IMPORTANT FIX: Wildcard must have a parameter name
// This catches any request that didn't match any route above
// ============================================

// FIXED: Added 'path' parameter name after the wildcard
// Without this, you'll get the "Missing parameter name" error
app.use("/*path", (req, res) => {
  res.status(404).json({
    error: "Not found",
    message: `Cannot ${req.method} ${req.url}`, // Show what they tried to access
  });
});

// ============================================
// ERROR HANDLING MIDDLEWARE
// Must be LAST - after all routes and 404 handler
// ============================================

app.use(errorHandler);

// ============================================
// START SERVER
// Begins listening for incoming HTTP requests
// ============================================

const PORT = process.env.PORT || 3000; // Use port from .env or default to 3000

app.listen(PORT, () => {
  // This callback runs when server successfully starts
  console.log(`\n🚀 Server running on http://localhost:${PORT}`);
  console.log(`📝 Available endpoints:`);
  console.log(`   GET    /api/health     - Health check`);
  console.log(`   GET    /api/products   - Get all products`);
  console.log(`   GET    /api/products/:id - Get one product`);
  console.log(`   POST   /api/products   - Create product (auth required)`);
  console.log(`   PUT    /api/products/:id - Update product (auth required)`);
  console.log(`   DELETE /api/products/:id - Delete product (auth required)`);
  console.log(`\n🔑 Auth token: Bearer my-secret-token`);
  console.log(
    `📊 Database: MariaDB on ${process.env.DB_HOST || "localhost"}\n`,
  );
});
