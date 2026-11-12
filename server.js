require('dotenv').config(); // MUST be the first line
const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const JWT_SECRET = process.env.JWT_SECRET || 'erp_super_secret_key_2026';

const pool = new Pool({
    connectionString: process.env.DATABASE_URL
});

// --- AUTOMATIC DATABASE INITIALIZATION & SEEDING ---
async function initializeERPDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                role VARCHAR(20) CHECK (role IN ('ADMIN', 'EMPLOYEE')) NOT NULL
            );

            CREATE TABLE IF NOT EXISTS products (
                sku VARCHAR(50) PRIMARY KEY,
                name VARCHAR(150) NOT NULL,
                quantity INT DEFAULT 0,
                unit_price DECIMAL(10,2) NOT NULL,
                location VARCHAR(50) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS stock_logs (
                id SERIAL PRIMARY KEY,
                sku VARCHAR(50) REFERENCES products(sku),
                action_type VARCHAR(10) CHECK (action_type IN ('IN', 'OUT')) NOT NULL,
                quantity_changed INT NOT NULL,
                performed_by VARCHAR(50) NOT NULL,
                timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        // Seed default accounts if none exist (Password: 123456 for both)
        const userCheck = await pool.query('SELECT COUNT(*) FROM users');
        if (parseInt(userCheck.rows[0].count) === 0) {
            const salt = await bcrypt.genSalt(10);
            const defaultPass = await bcrypt.hash('123456', salt);
            
            await pool.query(`
                INSERT INTO users (username, password_hash, role) VALUES 
                ('AdminBoss', $1, 'ADMIN'),
                ('SalesEmployee', $2, 'EMPLOYEE')
            `, [defaultPass, defaultPass]);
        }
        console.log('[ERP Database] Core schema and default accounts verified.');
    } catch (err) {
        console.error('[Database Error]', err.message);
    }
}

// --- API AUTHENTICATION ROUTE ---
app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
        if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid username or password' });

        const user = result.rows[0];
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) return res.status(401).json({ error: 'Invalid username or password' });

        const token = jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '12h' });
        res.json({ token, username: user.username, role: user.role });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- ERP INVENTORY & SALES ROUTES ---

app.get('/api/inventory', async (req, res) => {
    try {
        const result = await pool.query('SELECT *, (quantity * unit_price) AS total_value FROM products ORDER BY created_at DESC');
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/inventory', async (req, res) => {
    const { sku, name, quantity, unit_price, location } = req.body;
    try {
        await pool.query(
            'INSERT INTO products (sku, name, quantity, unit_price, location) VALUES ($1, $2, $3, $4, $5)',
            [sku, name, quantity, unit_price, location]
        );
        res.status(201).json({ message: 'Product added successfully' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.post('/api/movement', async (req, res) => {
    const { sku, action_type, quantity, performed_by } = req.body;
    const multiplier = action_type === 'IN' ? 1 : -1;
    const change = quantity * multiplier;

    try {
        if (action_type === 'OUT') {
            const stockCheck = await pool.query('SELECT quantity FROM products WHERE sku = $1', [sku]);
            if (stockCheck.rows.length === 0) return res.status(404).json({ error: 'Product not found' });
            if (stockCheck.rows[0].quantity < quantity) {
                return res.status(400).json({ error: 'Insufficient stock available for this sale/dispatch!' });
            }
        }

        await pool.query('UPDATE products SET quantity = quantity + $1 WHERE sku = $2', [change, sku]);
        await pool.query(
            'INSERT INTO stock_logs (sku, action_type, quantity_changed, performed_by) VALUES ($1, $2, $3, $4)',
            [sku, action_type, quantity, performed_by || 'System']
        );
        res.json({ message: 'Transaction recorded successfully' });
    } catch (err) {
        res.status(400).json({ error: err.message });
    }
});

app.get('/api/reports/sales', async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT 
                l.id, 
                l.timestamp, 
                l.performed_by, 
                l.action_type, 
                l.sku, 
                p.name AS product_name, 
                l.quantity_changed, 
                p.unit_price, 
                (l.quantity_changed * p.unit_price) AS total_sale_value
            FROM stock_logs l
            JOIN products p ON l.sku = p.sku
            ORDER BY l.timestamp DESC
        `);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    await initializeERPDatabase();
    console.log(`[ERP Server] Live online at http://localhost:${PORT}`);
});