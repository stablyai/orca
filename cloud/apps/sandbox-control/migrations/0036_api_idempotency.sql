-- Idempotency-Key for public API creates (POST /v1/workspaces): a retried request with the same key
-- gets the first request's response instead of booting a second sandbox. Kept 24h. Additive.
CREATE TABLE api_idempotency (
  account_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  -- SHA-256 of the canonical request body: the same key with a different body is refused.
  request_hash TEXT NOT NULL,
  -- pending (first request still running) | done
  state TEXT NOT NULL,
  status INTEGER,
  response TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, scope, idem_key)
);
CREATE INDEX api_idempotency_expiry ON api_idempotency (expires_at);
