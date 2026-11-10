-- One-time trial (N11, O7): 2 sandbox hours per new team, no card, granted once per team and
-- once per user, verified email, GitHub user and GitHub owner. A subscription on the account ends
-- it (entitlements.ts ignores the trial once any subscription row exists). Times are epoch ms.
CREATE TABLE trials (
  account_id TEXT PRIMARY KEY,
  granted_at INTEGER NOT NULL,
  included_seconds INTEGER NOT NULL DEFAULT 7200,
  -- Cache of SUM(usage_events.weighted_seconds) with no subscription (period_start IS NULL).
  used_seconds INTEGER NOT NULL DEFAULT 0,
  exhausted_at INTEGER,
  granted_by_user TEXT NOT NULL,
  github_owner_id TEXT,
  github_user_id TEXT,
  -- Set when a later check (GitHub binding) finds the same GitHub user/owner already used a trial.
  revoked_at INTEGER,
  revoked_reason TEXT
);

-- Abuse keys. kind: 'user' | 'email' | 'github_user' | 'github_owner' | 'ip'. key_hash is SHA-256
-- of the normalized value, so raw emails and IPs are never stored. granted = 1 once the key is
-- consumed by a granted trial (0 = seen on the account before a grant, e.g. a GitHub binding).
CREATE TABLE trial_claims (
  kind TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  account_id TEXT NOT NULL,
  granted INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (kind, key_hash, account_id)
);
CREATE INDEX trial_claims_account ON trial_claims(account_id);
CREATE INDEX trial_claims_recent ON trial_claims(kind, key_hash, created_at);
