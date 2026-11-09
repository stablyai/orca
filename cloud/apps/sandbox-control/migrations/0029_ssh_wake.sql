-- Wake on SSH. One row per sandbox that has SSH set up: the hashed per-sandbox wake secret the
-- desktop's ProxyCommand presents (scoped: it can only wake this sandbox and start its sshd
-- bridge), the token the VM's WebSocket bridge requires, and the authorized public key.
CREATE TABLE sandbox_ssh (
  sandbox_id TEXT PRIMARY KEY REFERENCES sandboxes (id),
  wake_secret_sha256 TEXT NOT NULL,
  bridge_token TEXT NOT NULL,
  public_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
