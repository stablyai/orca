-- Programmatic access: org-scoped API keys, audit log, projects, workspace messages, routines and
-- MCP OAuth. All additive: older Workers keep working against this schema.

-- API keys. Only the SHA-256 of the full key is stored; `prefix` is the non-secret display part.
-- kind=user: created in Settings, acts as `created_by` inside `account_id` with `scopes`.
-- kind=workspace: minted per VM session for the in-VM `orca` CLI; bound to `sandbox_id`.
CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  -- Role of the creator when the key was made; admin-only scopes need owner/admin here.
  creator_role TEXT,
  name TEXT NOT NULL,
  prefix TEXT NOT NULL,
  secret_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'user',
  sandbox_id TEXT,
  expires_at INTEGER,
  last_used_at INTEGER,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  revoked_by TEXT
);
CREATE INDEX api_keys_account ON api_keys (account_id, revoked_at);
CREATE INDEX api_keys_sandbox ON api_keys (sandbox_id) WHERE sandbox_id IS NOT NULL;

-- Append-only audit trail of every mutating API call (keys, workspaces, routines, settings).
CREATE TABLE audit_log (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  -- user | api_key | workspace_token | routine | mcp | system
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  user_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  -- Small JSON object; never secrets.
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX audit_log_account ON audit_log (account_id, created_at);

-- A project is a repo + defaults that workspaces and routines start from.
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  repo_url TEXT,
  default_ref TEXT,
  machine_size TEXT NOT NULL DEFAULT 'standard',
  region TEXT,
  -- Pinned org environment build (bld_…, W1 environments); NULL = the active build for the repo.
  build_id TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE UNIQUE INDEX projects_live_name ON projects (account_id, name) WHERE archived_at IS NULL;

ALTER TABLE sandboxes ADD COLUMN project_id TEXT;
ALTER TABLE sandboxes ADD COLUMN name TEXT;
ALTER TABLE sandboxes ADD COLUMN archived_at INTEGER;
-- desktop | api | mcp | routine | vm (created from inside another workspace)
ALTER TABLE sandboxes ADD COLUMN origin TEXT;
ALTER TABLE sandboxes ADD COLUMN origin_ref TEXT;
-- Routine runs and other machine-made workspaces stay out of default lists.
ALTER TABLE sandboxes ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;

-- Messages for a workspace's agent. Queued first (write-ahead), delivered once the VM is up.
CREATE TABLE workspace_messages (
  id TEXT PRIMARY KEY,
  sandbox_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  sent_by TEXT NOT NULL,
  agent TEXT NOT NULL,
  -- Terminal handle of the agent session to continue; NULL starts a new session.
  session_handle TEXT,
  body TEXT NOT NULL,
  -- queued | delivering | delivered | failed
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  result_handle TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  delivered_at INTEGER
);
CREATE INDEX workspace_messages_sandbox ON workspace_messages (sandbox_id, created_at);
CREATE INDEX workspace_messages_pending ON workspace_messages (status, updated_at);

-- Per-account settings for programmatic access.
CREATE TABLE account_settings (
  account_id TEXT PRIMARY KEY,
  -- 1: VMs get a workspace token so agents inside can create sibling workspaces.
  vm_cli_enabled INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT,
  updated_at INTEGER NOT NULL
);

-- Routines: an agent prompt that runs in a fresh VM on a schedule, a GitHub event or a webhook.
CREATE TABLE routines (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  name TEXT NOT NULL,
  project_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  -- schedule | github | webhook
  trigger_kind TEXT NOT NULL,
  -- JSON: {cron, timezone} | {events, labels, authors, baseBranches} | {}
  trigger_config TEXT NOT NULL,
  webhook_id TEXT UNIQUE,
  webhook_secret_hash TEXT,
  agent TEXT NOT NULL,
  prompt TEXT NOT NULL,
  machine_size TEXT NOT NULL DEFAULT 'standard',
  -- none | comment | pr
  post_results TEXT NOT NULL DEFAULT 'comment',
  max_runtime_ms INTEGER NOT NULL,
  next_run_at INTEGER,
  last_run_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX routines_account ON routines (account_id, deleted_at);
CREATE INDEX routines_due ON routines (trigger_kind, enabled, next_run_at);

CREATE TABLE routine_runs (
  id TEXT PRIMARY KEY,
  routine_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  -- schedule | github | webhook | manual
  trigger_kind TEXT NOT NULL,
  -- JSON summary of what fired it (scheduled time, PR number, webhook payload digest).
  trigger_detail TEXT,
  -- Dedupe key: one run per scheduled slot / GitHub delivery.
  dedupe_key TEXT UNIQUE,
  -- queued | starting | running | posting | succeeded | failed | cancelled | timed_out
  status TEXT NOT NULL,
  sandbox_id TEXT,
  -- JSON: {summary, prUrl, commentUrl, exitCode}
  result TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX routine_runs_routine ON routine_runs (routine_id, created_at);
CREATE INDEX routine_runs_active ON routine_runs (status, updated_at);

-- MCP OAuth 2.1: dynamically registered clients, single-use auth codes, and issued tokens.
CREATE TABLE oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_name TEXT,
  redirect_uris TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  creator_role TEXT,
  scopes TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource TEXT,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
