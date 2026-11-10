-- Read a sleeping workspace without waking it (gap 5). Every device keeps one X25519 "reader key";
-- only the public half is stored here. At each drain the VM seals a compact snapshot (chats, agent
-- status, git, PR) to the reader keys allowed to open the workspace; this database keeps only that
-- ciphertext and one wrapped content key per reader key, never plaintext.
CREATE TABLE IF NOT EXISTS reader_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  dev INTEGER NOT NULL DEFAULT 0,
  public_key TEXT NOT NULL,
  device_kind TEXT NOT NULL,
  device_label TEXT NOT NULL,
  -- A phone's key dies with its device session (unpair, revoke, member removal).
  device_session_id TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS reader_keys_live ON reader_keys (account_id, user_id, public_key) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS reader_keys_account ON reader_keys (account_id, revoked_at);
CREATE INDEX IF NOT EXISTS reader_keys_device_session ON reader_keys (device_session_id);

-- One snapshot per workspace, replaced at every drain.
CREATE TABLE IF NOT EXISTS read_snapshots (
  sandbox_id TEXT PRIMARY KEY,
  snapshot_id TEXT NOT NULL,
  stored_at INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  nonce TEXT NOT NULL,
  ciphertext TEXT NOT NULL
);

-- The snapshot's content key wrapped to one reader key. Deleting a row is how access is pruned
-- (member removed, workspace made private, key revoked) without waking the VM.
CREATE TABLE IF NOT EXISTS read_snapshot_keys (
  sandbox_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  ephemeral_public_key TEXT NOT NULL,
  nonce TEXT NOT NULL,
  wrapped_key TEXT NOT NULL,
  PRIMARY KEY (sandbox_id, key_id)
);
CREATE INDEX IF NOT EXISTS read_snapshot_keys_key ON read_snapshot_keys (key_id);
