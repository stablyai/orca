import type Database from '../sqlite/sync-database'

/** Rebuildable indices for the canonical profile document; no released schema version changes. */
export function ensureWorkspaceSurfaceTables(db: Database.Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS main.workspace_surface_domains (
  host_id TEXT PRIMARY KEY NOT NULL,
  initialized INTEGER NOT NULL,
  revision INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS main.workspace_surface_index_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  fingerprint TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS main.workspace_surfaces (
  host_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  host_tab_id TEXT NOT NULL,
  row_json TEXT NOT NULL,
  session_id TEXT,
  PRIMARY KEY (host_id, workspace_id, host_tab_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS main.idx_workspace_surface_chat
  ON workspace_surfaces(host_id, session_id) WHERE session_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS main.idx_workspace_surface_open_tab
  ON workspace_surfaces(host_id, host_tab_id)
  WHERE json_extract(row_json, '$.content') IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS main.idx_workspace_surface_terminal
  ON workspace_surfaces(host_id, json_extract(row_json, '$.content.entityId'))
  WHERE json_extract(row_json, '$.content.kind') = 'terminal';
CREATE TABLE IF NOT EXISTS main.workspace_surface_leaves (
  host_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  host_tab_id TEXT NOT NULL,
  leaf_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  pty_id TEXT,
  PRIMARY KEY (host_id, leaf_id),
  UNIQUE (host_id, run_id),
  UNIQUE (host_id, pty_id)
);
CREATE INDEX IF NOT EXISTS main.idx_workspace_surface_leaf_owner
  ON workspace_surface_leaves(host_id, workspace_id, host_tab_id);
CREATE TABLE IF NOT EXISTS main.workspace_surface_commands (
  host_id TEXT NOT NULL,
  caller_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  result_json TEXT NOT NULL,
  PRIMARY KEY (host_id, caller_id, command_id)
);
CREATE INDEX IF NOT EXISTS main.idx_workspace_surface_command_expiry
  ON workspace_surface_commands(expires_at);
CREATE TABLE IF NOT EXISTS main.workspace_surface_allocations (
  allocation_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  host_tab_id TEXT NOT NULL,
  leaf_id TEXT NOT NULL,
  row_json TEXT NOT NULL,
  PRIMARY KEY (host_id, allocation_id)
);
CREATE INDEX IF NOT EXISTS main.idx_workspace_surface_allocation_target
  ON workspace_surface_allocations(host_id, workspace_id, host_tab_id);
CREATE TABLE IF NOT EXISTS main.workspace_surface_projections (
  host_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  baseline_json TEXT NOT NULL,
  pending_json TEXT,
  PRIMARY KEY (host_id, workspace_id)
);`)
}
