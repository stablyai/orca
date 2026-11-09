-- Warm pool: VMs booted from the current golden image with egress denied, waiting to be claimed by a
-- create. The id is the sandbox id the claiming row will take, so the provider name and the ownership tag
-- already match. Rows leave by claim (DELETE ... RETURNING) or recycle; nothing here is billed to anyone.
CREATE TABLE sandbox_pool (
  id TEXT PRIMARY KEY,
  provider_name TEXT NOT NULL UNIQUE,
  machine_size TEXT NOT NULL,
  region TEXT NOT NULL,
  snapshot_id TEXT NOT NULL,
  -- warming (create in flight) | ready
  status TEXT NOT NULL,
  session_id TEXT,
  session_started_at INTEGER,
  session_timeout_ms INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX sandbox_pool_claim ON sandbox_pool (status, machine_size, region, snapshot_id, created_at);
