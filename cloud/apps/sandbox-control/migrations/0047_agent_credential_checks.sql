-- A provider 401 on an Orca-account request no longer revokes on its own: the control plane confirms
-- with one cheap server-side auth check first (agent-credential-checks.ts). checked_at rate-limits those
-- checks per person and agent; every outcome is audited.
ALTER TABLE agent_credentials ADD COLUMN checked_at INTEGER;

CREATE TABLE agent_credential_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  -- revoked | kept | skipped
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  sandbox_id TEXT,
  upstream_path TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX agent_credential_audit_user ON agent_credential_audit (user_id, created_at);
