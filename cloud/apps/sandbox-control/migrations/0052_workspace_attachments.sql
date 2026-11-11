-- Files uploaded through the public API / MCP for an agent to read (G10 attachments). The bytes live
-- on the workspace's own disk (/vercel/sandbox/attachments/<id>/<filename>, outside the repo); this
-- row lets a message reference the file by id. Additive only.
CREATE TABLE IF NOT EXISTS workspace_attachments (
  id TEXT PRIMARY KEY,
  sandbox_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  uploaded_by TEXT NOT NULL,
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  path TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS workspace_attachments_sandbox ON workspace_attachments (sandbox_id, created_at);
