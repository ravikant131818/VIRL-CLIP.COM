import express from 'express';
import path from 'path';
import fs from 'fs';
import { createServer as createViteServer } from 'vite';
import multer from 'multer';
import dotenv from 'dotenv';
import { v2 as cloudinary } from 'cloudinary';

dotenv.config();

const app = express();
const PORT = 3000;

const ADMIN_SECRET = process.env.ADMIN_SECRET || 'RAVIKANT@18';
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');
const DATA_FILE = path.join(process.cwd(), 'uploads', 'photos.json');

// Configure Cloudinary if credentials provided
const cloudName = process.env.CLOUDINARY_CLOUD_NAME || process.env.VITE_CLOUDINARY_CLOUD_NAME;
const apiKey = process.env.CLOUDINARY_API_KEY;
const apiSecret = process.env.CLOUDINARY_API_SECRET;

const isCloudinaryConfigured = Boolean(cloudName && apiKey && apiSecret);

if (isCloudinaryConfigured) {
  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
  });
}

// Ensure uploads folder exists
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Multer storage engine
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (_req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `photo-${uniqueSuffix}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB limit
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed.'));
    }
  },
});

app.use(express.json());
app.use('/uploads', express.static(UPLOADS_DIR));

// Helper to read database
async function getStoredPhotos(): Promise<any[]> {
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify([], null, 2));
    return [];
  }
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    const filtered = parsed.filter((p: any) => !p.id.startsWith('photo-seed-'));
    if (filtered.length !== parsed.length) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(filtered, null, 2));
    }
    return filtered;
  } catch {
    return [];
  }
}

// Helper to save database
async function saveStoredPhoto(photoRecord: any) {
  let localPhotos: any[] = [];
  if (fs.existsSync(DATA_FILE)) {
    try {
      localPhotos = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    } catch {
      localPhotos = [];
    }
  }
  localPhotos.unshift(photoRecord);
  fs.writeFileSync(DATA_FILE, JSON.stringify(localPhotos, null, 2));
}

async function removeStoredPhoto(photoId: string): Promise<any | null> {
  let deletedPhoto: any = null;

  if (fs.existsSync(DATA_FILE)) {
    try {
      const photos = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      const idx = photos.findIndex((p: any) => p.id === photoId);
      if (idx !== -1) {
        deletedPhoto = photos[idx];
        photos.splice(idx, 1);
        fs.writeFileSync(DATA_FILE, JSON.stringify(photos, null, 2));
      }
    } catch (err) {
      console.error('Error reading local data:', err);
    }
  }

  return deletedPhoto;
}

// Admin authorization middleware
function requireAdmin(req: express.Request, res: express.Response, next: express.NextFunction) {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== ADMIN_SECRET) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// --- API ROUTES ---

// Config API
app.get('/api/config', (_req, res) => {
  const cName = process.env.CLOUDINARY_CLOUD_NAME || process.env.VITE_CLOUDINARY_CLOUD_NAME || '';

  res.json({
    cloudinaryConfigured: isCloudinaryConfigured || Boolean(cName && process.env.VITE_CLOUDINARY_UPLOAD_PRESET),
    cloudName: cName,
    uploadPreset: process.env.VITE_CLOUDINARY_UPLOAD_PRESET || '',
    hasCustomAdminPasscode: Boolean(process.env.ADMIN_SECRET),
  });
});

// Verify Admin Passcode API
app.post('/api/verify-admin', (req, res) => {
  const { passcode } = req.body;
  if (passcode && passcode === ADMIN_SECRET) {
    res.json({ success: true, message: 'Admin verified successfully' });
  } else {
    res.status(401).json({ success: false, message: 'Unauthorized' });
  }
});

// Fetch all photos (Public)
app.get('/api/photos', async (_req, res) => {
  const photos = await getStoredPhotos();
  res.json(photos);
});

// Upload Photo (Admin Only)
app.post('/api/photos', requireAdmin, upload.single('photo'), async (req, res) => {
  try {
    const { title, cloudinaryUrl, publicId, width, height } = req.body;

    let photoRecord: any;

    if (cloudinaryUrl) {
      // Client direct upload to Cloudinary
      photoRecord = {
        id: 'photo-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
        title: title || 'Untitled Photo',
        url: cloudinaryUrl,
        publicId: publicId || null,
        storagePath: publicId || null,
        storageProvider: 'cloudinary',
        size: Number(req.body.size) || 0,
        createdAt: new Date().toISOString(),
        width: width ? Number(width) : undefined,
        height: height ? Number(height) : undefined,
      };
    } else if (req.file && isCloudinaryConfigured) {
      // Server upload to Cloudinary SDK
      const cldRes = await cloudinary.uploader.upload(req.file.path, {
        folder: 'photo-gallery',
      });

      // Cleanup local temp file
      if (fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }

      photoRecord = {
        id: 'photo-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
        title: title || req.file.originalname.replace(/\.[^/.]+$/, '') || 'Untitled Photo',
        url: cldRes.secure_url,
        publicId: cldRes.public_id,
        storagePath: cldRes.public_id,
        storageProvider: 'cloudinary',
        size: cldRes.bytes || req.file.size,
        createdAt: new Date().toISOString(),
        width: cldRes.width || (width ? Number(width) : 1200),
        height: cldRes.height || (height ? Number(height) : 900),
      };
    } else if (req.file) {
      // Local fallback file upload
      const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
      photoRecord = {
        id: 'photo-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
        title: title || req.file.originalname.replace(/\.[^/.]+$/, '') || 'Untitled Photo',
        url: fileUrl,
        storagePath: req.file.filename,
        storageProvider: 'local',
        size: req.file.size,
        createdAt: new Date().toISOString(),
        width: width ? Number(width) : 1200,
        height: height ? Number(height) : 900,
      };
    } else {
      res.status(400).json({ error: 'No image file or URL provided' });
      return;
    }

    await saveStoredPhoto(photoRecord);

    res.status(201).json(photoRecord);
  } catch (error: any) {
    console.error('Error saving photo:', error);
    res.status(500).json({ error: error.message || 'Failed to upload photo' });
  }
});

// Delete Photo (Admin Only)
app.delete('/api/photos/:id', requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const photo = await removeStoredPhoto(id);

    if (!photo) {
      res.status(404).json({ error: 'Photo not found' });
      return;
    }

    // Delete from Cloudinary if stored on Cloudinary
    if (photo.storageProvider === 'cloudinary') {
      const pId = photo.publicId || photo.storagePath;
      if (pId && isCloudinaryConfigured) {
        await cloudinary.uploader.destroy(pId);
      }
    }

    // Delete local file if stored locally
    if (photo.storageProvider === 'local' && photo.storagePath) {
      const filePath = path.join(UPLOADS_DIR, photo.storagePath);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    res.json({ success: true, message: 'Photo deleted successfully' });
  } catch (error: any) {
    console.error('Error deleting photo:', error);
    res.status(500).json({ error: error.message || 'Failed to delete photo' });
  }
});

// Express + Vite Integration
async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
