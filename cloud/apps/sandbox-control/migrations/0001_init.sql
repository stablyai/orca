-- One row per Orca Cloud workspace sandbox. Written before any provider call (write-ahead), so a
-- crash mid-create leaves a row the cron reconciles instead of an untracked VM.
CREATE TABLE sandboxes (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  machine_size TEXT NOT NULL,
  region TEXT NOT NULL,
  -- Bumped on every transition; lifecycle writes compare-and-set on it.
  generation INTEGER NOT NULL DEFAULT 0,
  session_id TEXT,
  session_started_at INTEGER,
  session_deadline_at INTEGER,
  lease_expires_at INTEGER,
  -- Start of the not-yet-reported usage segment of the current session.
  usage_settled_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  destroyed_at INTEGER
);

CREATE UNIQUE INDEX sandboxes_live_workspace
  ON sandboxes (account_id, workspace_id) WHERE status <> 'destroyed';
CREATE INDEX sandboxes_status ON sandboxes (status, updated_at);

-- Every snapshot id seen for a sandbox, so destroy can prove none outlive it.
CREATE TABLE sandbox_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  sandbox_id TEXT NOT NULL REFERENCES sandboxes (id),
  recorded_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX sandbox_snapshots_sandbox ON sandbox_snapshots (sandbox_id);

-- Usage segments owed to billing. Written before the row's settle cursor advances, so a billing
-- outage delays reports instead of dropping them; usage_id makes resends idempotent upstream.
CREATE TABLE usage_outbox (
  usage_id TEXT PRIMARY KEY,
  sandbox_id TEXT NOT NULL REFERENCES sandboxes (id),
  account_id TEXT NOT NULL,
  machine_size TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER
);
CREATE INDEX usage_outbox_pending ON usage_outbox (sent_at, started_at);
