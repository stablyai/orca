-- GitHub App installations bound to Orca accounts. Repo tokens are minted only for a caller whose
-- account has a live binding to the installation that covers the repo (deny by default).
CREATE TABLE github_installations (
  installation_id INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  github_account_id INTEGER NOT NULL,
  github_account_login TEXT NOT NULL,
  github_account_type TEXT NOT NULL,
  -- Orca user who bound it, and the GitHub user proven (OAuth) to own/admin the installation account.
  bound_by_user_id TEXT NOT NULL,
  bound_by_github_user_id INTEGER,
  -- `oauth` (owner/org admin verified with a user-to-server token) | `operator` (support tool).
  method TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  PRIMARY KEY (installation_id, account_id)
);
CREATE INDEX github_installations_account ON github_installations (account_id);

-- Single-use install/connect state nonces (signed state carries the account; this stops replay).
CREATE TABLE github_connect_states (
  nonce TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);

-- Operator flags (kill switch) and cron bookkeeping; D1 so flipping needs no redeploy.
CREATE TABLE control_state (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Fixed-window create counters per account.
CREATE TABLE rate_windows (
  bucket TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);

-- Provider resources with no live D1 record: suspended on first sight, deleted after a grace period.
CREATE TABLE provider_orphans (
  kind TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  suspended_at INTEGER,
  deleted_at INTEGER,
  PRIMARY KEY (kind, provider_id)
);

-- Accounts whose subscription is canceled/unpaid: data is deleted DATA_RETENTION_DAYS after `since`.
CREATE TABLE account_holds (
  account_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL,
  since INTEGER NOT NULL,
  checked_at INTEGER NOT NULL,
  warned_at INTEGER,
  purged_at INTEGER
);

-- Idle-retention warning marker for long-suspended sandboxes.
ALTER TABLE sandboxes ADD COLUMN retention_warned_at INTEGER;
