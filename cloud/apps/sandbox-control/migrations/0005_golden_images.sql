-- Golden images the Worker builds and rotates on its own. One row is `active`; the previous one
-- stays `retired` (kept, usable) until a newer image has passed its smoke test.
CREATE TABLE golden_images (
  id TEXT PRIMARY KEY,
  -- seed | clone:<snapshot> | release:<tag>
  source TEXT NOT NULL,
  bundle_sha256 TEXT,
  -- building | smoking | active | retired | failed | deleted
  status TEXT NOT NULL,
  build_name TEXT,
  session_id TEXT,
  command_id TEXT,
  snapshot_id TEXT,
  expires_at INTEGER,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  activated_at INTEGER
);
CREATE INDEX golden_images_status ON golden_images (status, activated_at);
