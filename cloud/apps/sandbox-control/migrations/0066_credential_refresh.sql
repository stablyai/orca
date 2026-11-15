-- EGRESS-REFRESH: central, proactive credential refresh (credential-refresh.ts). With credentials swapped at the
-- sandbox firewall nothing sees a provider 401 any more, so tokens are renewed before they expire and every
-- change is pushed into the running sandboxes' policies.
--
-- GitHub user-to-server tokens (8 h, single-use rotating refresh tokens): one lease per member, so only one
-- refresh ever spends a refresh token, and backoff for failures. last_error 'bad_refresh_token' or
-- 'refresh_expired' ends the connection until the member connects GitHub again.
ALTER TABLE github_user_tokens ADD COLUMN lease_owner TEXT;
ALTER TABLE github_user_tokens ADD COLUMN lease_until INTEGER;
ALTER TABLE github_user_tokens ADD COLUMN refresh_failures INTEGER NOT NULL DEFAULT 0;
ALTER TABLE github_user_tokens ADD COLUMN next_attempt_at INTEGER;
ALTER TABLE github_user_tokens ADD COLUMN last_error TEXT;
CREATE INDEX github_user_tokens_access_expiry ON github_user_tokens (access_expires_at);

-- Account sign-ins (agent_credentials): when an expiry was last pushed to running sandboxes, so an expired
-- sign-in leaves their policies once (and its placeholder gets the provider's "sign in again" answer).
ALTER TABLE agent_credentials ADD COLUMN expiry_pushed_at INTEGER;

-- Outbox of credential changes still to reach running sandboxes' policies. Every refresh, revoke, expiry or
-- removal upserts its row (changed_at); the pusher rewrites the affected sandboxes' policies and marks it
-- pushed only up to the change it saw (compare-and-swap), so a change landing mid-push is pushed again.
-- kind: 'account:claude' | 'account:codex' (subject = user id) | 'github_user' (subject = account#user).
CREATE TABLE credential_pushes (
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  changed_at INTEGER NOT NULL,
  pushed_at INTEGER,
  lease_owner TEXT,
  lease_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER,
  PRIMARY KEY (kind, subject)
);
CREATE INDEX credential_pushes_pending ON credential_pushes (changed_at);
