export function createMaestroTablesSql(): string {
  return `
CREATE TABLE IF NOT EXISTS maestro_documents (
  execution_host_id TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  run_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  document_json TEXT NOT NULL DEFAULT '{"nodes":{}}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (execution_host_id, workspace_key)
);

CREATE TABLE IF NOT EXISTS maestro_mutation_receipts (
  execution_host_id TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (execution_host_id, workspace_key, mutation_id)
);

CREATE TABLE IF NOT EXISTS maestro_deltas (
  execution_host_id TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  delta_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (execution_host_id, workspace_key, revision)
);
CREATE INDEX IF NOT EXISTS idx_maestro_deltas_cursor
  ON maestro_deltas(execution_host_id, workspace_key, revision);

CREATE TABLE IF NOT EXISTS maestro_run_projections (
  run_id TEXT PRIMARY KEY,
  home_execution_host_id TEXT NOT NULL,
  home_workspace_key TEXT NOT NULL,
  execution_execution_host_id TEXT NOT NULL,
  execution_workspace_key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  view_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS maestro_bootstrap_records (
  mutation_id TEXT PRIMARY KEY,
  execution_host_id TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  run_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_maestro_bootstrap_records_workspace
  ON maestro_bootstrap_records(execution_host_id, workspace_key, updated_at);

CREATE TABLE IF NOT EXISTS maestro_human_reviews (
  review_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  execution_host_id TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  dispatch_id TEXT NOT NULL,
  references_json TEXT NOT NULL,
  review_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_maestro_human_reviews_run
  ON maestro_human_reviews(execution_host_id, workspace_key, run_id, updated_at);

CREATE TABLE IF NOT EXISTS maestro_context_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  execution_host_id TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  note_id TEXT NOT NULL,
  note_revision TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  owner_principal TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  released_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(execution_host_id, workspace_key, run_id, note_id, note_revision, content_hash, owner_principal)
);
CREATE INDEX IF NOT EXISTS idx_maestro_context_snapshots_run
  ON maestro_context_snapshots(execution_host_id, workspace_key, run_id, released_at);

CREATE TABLE IF NOT EXISTS maestro_delegation_intents (
  intent_id TEXT PRIMARY KEY,
  execution_host_id TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  run_id TEXT NOT NULL,
  requester_principal TEXT NOT NULL,
  requester_kind TEXT NOT NULL,
  coordinator_generation INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending', 'claimed', 'settled', 'rejected')),
  consumer_principal TEXT,
  payload_json TEXT NOT NULL,
  receipt_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_maestro_delegation_intents_scope
  ON maestro_delegation_intents(execution_host_id, workspace_key, run_id, state, created_at);

CREATE TABLE IF NOT EXISTS terminal_close_intents (
  mutation_id TEXT PRIMARY KEY,
  execution_host_id TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  terminal_handle TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK(target_kind IN ('terminal', 'terminal-tab')),
  pty_incarnation TEXT NOT NULL,
  process_root_id TEXT NOT NULL,
  owner_principal TEXT NOT NULL,
  reason TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN (
    'reserved', 'closing', 'released', 'outcome_unknown', 'capability_limited'
  )),
  auto_release INTEGER NOT NULL DEFAULT 0 CHECK(auto_release IN (0, 1)),
  result_json TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(execution_host_id, workspace_key, terminal_handle, pty_incarnation, process_root_id)
);
CREATE INDEX IF NOT EXISTS idx_terminal_close_intents_pending
  ON terminal_close_intents(state, updated_at);
`
}
