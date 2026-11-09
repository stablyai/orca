-- Phones (and other companion clients) holding their own revocable Orca Cloud access. A signed-in
-- desktop enrolls the device's Ed25519 public key; the device then signs short-lived tokens itself,
-- so no bearer secret is ever stored here. Identity is the enrolling caller's, snapshotted.
CREATE TABLE IF NOT EXISTS device_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  org_id TEXT,
  org_role TEXT,
  dev INTEGER NOT NULL DEFAULT 0,
  label TEXT NOT NULL,
  platform TEXT NOT NULL,
  public_key TEXT NOT NULL,
  -- The desktop's id for the paired phone, so unpairing it there also ends its cloud access.
  paired_device_id TEXT,
  created_at INTEGER NOT NULL,
  refreshed_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS device_sessions_live_key ON device_sessions (public_key) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS device_sessions_user ON device_sessions (user_id, revoked_at);
CREATE INDEX IF NOT EXISTS device_sessions_key ON device_sessions (public_key);
