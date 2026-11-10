-- Codex account broker (agent-accounts spec A2, contract D11 / flag S2). Additive only.
-- The credential itself lives in agent_credentials (0044); these tables hold no token.

-- One device login in a short-lived broker sandbox. The user code is shown only to its owner and
-- is useless after `expires_at` (Codex device codes last 15 minutes).
CREATE TABLE IF NOT EXISTS codex_broker_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  provider_name TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('starting', 'pending', 'completing', 'active', 'failed')),
  verification_url TEXT,
  user_code TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  -- Set once the broker sandbox is gone; the cron retries deletes until it is.
  destroyed_at INTEGER
);
CREATE INDEX IF NOT EXISTS codex_broker_sessions_user ON codex_broker_sessions (user_id, created_at);
CREATE INDEX IF NOT EXISTS codex_broker_sessions_live ON codex_broker_sessions (destroyed_at, expires_at);

-- The refresher's single-flight lease and schedule, one row per person with a Codex credential.
-- A refresh token is single-use: only the lease holder may spend it (refresh_token_reused otherwise).
CREATE TABLE IF NOT EXISTS codex_leases (
  user_id TEXT PRIMARY KEY,
  lease_owner TEXT,
  lease_until INTEGER,
  access_expires_at INTEGER,
  refreshed_at INTEGER,
  -- Backoff after a transient failure (the refresher skips the row until then).
  next_attempt_at INTEGER,
  failures INTEGER NOT NULL DEFAULT 0,
  -- An error code from the token endpoint (e.g. refresh_token_expired), never a token.
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS codex_leases_due ON codex_leases (access_expires_at);
