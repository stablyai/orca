-- Org environments ("Cloud Computer"): repos, an install script and env var names, built into a
-- versioned snapshot new workspaces boot from. Builds never replace the active one unless they
-- succeed, and any kept build can be re-activated (rollback).
CREATE TABLE environments (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  -- JSON [{"url":"https://github.com/o/r.git","defaultBranch":"main"|null}]
  repos TEXT NOT NULL,
  install_script TEXT NOT NULL,
  -- JSON ["NPM_TOKEN", ...]: org secrets with these names reach the install script.
  env_var_names TEXT NOT NULL,
  machine_size TEXT NOT NULL CHECK (machine_size IN ('standard', 'large')),
  active_build_id TEXT,
  -- Bumped on every config edit; a build records the revision it was made from.
  revision INTEGER NOT NULL DEFAULT 1,
  next_build_number INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE UNIQUE INDEX environments_account_name ON environments (account_id, name) WHERE deleted_at IS NULL;

CREATE TABLE environment_builds (
  id TEXT PRIMARY KEY,
  environment_id TEXT NOT NULL REFERENCES environments (id),
  account_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  -- starting | running | snapshotting | succeeded | failed | canceled
  status TEXT NOT NULL,
  -- Frozen config the build ran with (repos, script, env var names, machine size, revision).
  config TEXT NOT NULL,
  base_snapshot_id TEXT NOT NULL,
  provider_name TEXT NOT NULL UNIQUE,
  session_id TEXT,
  command_id TEXT,
  snapshot_id TEXT,
  -- JSON from the VM: per-repo commit + lockfile blob ids, disk use.
  result TEXT,
  -- Short failure code (`clone_failed`, `install_exit_2`, `timeout`, ...) and the step it hit.
  error TEXT,
  failed_step TEXT,
  log_bytes INTEGER NOT NULL DEFAULT 0,
  log_truncated INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  -- When the install finished and the snapshot began (the build timeline's last step).
  snapshot_started_at INTEGER,
  finished_at INTEGER,
  updated_at INTEGER NOT NULL,
  generation INTEGER NOT NULL DEFAULT 0,
  -- Old builds beyond the kept window lose their snapshot; the record (and log) stays.
  snapshot_deleted_at INTEGER,
  UNIQUE (environment_id, number)
);
CREATE INDEX environment_builds_env ON environment_builds (environment_id, number);
CREATE INDEX environment_builds_status ON environment_builds (status, updated_at);

-- Build output, stored once the build ends (live output streams straight from the VM).
CREATE TABLE environment_build_logs (
  build_id TEXT NOT NULL REFERENCES environment_builds (id),
  seq INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (build_id, seq)
);

-- Which build a workspace sandbox booted from: a rebuild never touches live workspaces.
ALTER TABLE sandboxes ADD COLUMN environment_id TEXT;
ALTER TABLE sandboxes ADD COLUMN environment_build_id TEXT;
ALTER TABLE sandboxes ADD COLUMN source_snapshot_id TEXT;
