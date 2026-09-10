export function createMaestroTerminalLeaseTablesSql(): string {
  return `
CREATE TABLE IF NOT EXISTS maestro_terminal_leases (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  execution_host_id TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  terminal_handle TEXT,
  tab_id TEXT,
  pane_key TEXT,
  pty_incarnation TEXT,
  process_root_id TEXT,
  run_id TEXT NOT NULL,
  task_id TEXT,
  attempt_id TEXT,
  coordinator_generation INTEGER,
  role TEXT NOT NULL CHECK(role IN ('coordinator', 'worker')),
  worker_terminal_resource_id TEXT,
  coordinator_run_id TEXT,
  title TEXT NOT NULL,
  launch_profile_json TEXT NOT NULL,
  parent_lease_id TEXT,
  spawned_by TEXT NOT NULL,
  owner_principal TEXT NOT NULL,
  retention_policy TEXT NOT NULL CHECK(retention_policy IN ('auto_release', 'retain')),
  lifecycle_state TEXT NOT NULL CHECK(lifecycle_state IN (
    'reserved', 'starting', 'ready', 'active', 'input_required', 'settled',
    'retained', 'release_pending', 'released', 'outcome_unknown', 'superseded', 'archived'
  )),
  observation TEXT CHECK(observation IN (
    'context_rollover', 'correction_exit', 'launch_profile_drift'
  )),
  provider_session_id TEXT,
  capsule_digest TEXT,
  cleanup_receipt_json TEXT,
  archived_tail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(parent_lease_id) REFERENCES maestro_terminal_leases(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_maestro_terminal_leases_coordinator_generation
  ON maestro_terminal_leases(run_id, coordinator_generation)
  WHERE role = 'coordinator';
CREATE UNIQUE INDEX IF NOT EXISTS idx_maestro_terminal_leases_worker_attempt
  ON maestro_terminal_leases(run_id, task_id, attempt_id)
  WHERE role = 'worker' AND attempt_id IS NOT NULL AND lifecycle_state != 'superseded';
CREATE UNIQUE INDEX IF NOT EXISTS idx_maestro_terminal_leases_worker_resource
  ON maestro_terminal_leases(worker_terminal_resource_id)
  WHERE worker_terminal_resource_id IS NOT NULL AND lifecycle_state != 'superseded';
CREATE UNIQUE INDEX IF NOT EXISTS idx_maestro_terminal_leases_live_terminal_owner
  ON maestro_terminal_leases(execution_host_id, workspace_key, terminal_handle, pty_incarnation)
  WHERE terminal_handle IS NOT NULL AND pty_incarnation IS NOT NULL
    AND lifecycle_state NOT IN ('released', 'superseded', 'archived');
CREATE INDEX IF NOT EXISTS idx_maestro_terminal_leases_lifecycle
  ON maestro_terminal_leases(run_id, lifecycle_state, role);

CREATE TABLE IF NOT EXISTS maestro_terminal_lease_transfer_receipts (
  request_id TEXT PRIMARY KEY,
  receipt_json TEXT NOT NULL,
  mutation_caller_fingerprint TEXT,
  mutation_request_id TEXT,
  mutation_method TEXT,
  mutation_payload_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS maestro_terminal_input_receipts (
  command_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  content_digest TEXT NOT NULL,
  enqueue_sequence INTEGER NOT NULL,
  sender_json TEXT NOT NULL,
  lease_id TEXT NOT NULL,
  execution_host_id TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  terminal_handle TEXT NOT NULL,
  tab_id TEXT NOT NULL,
  pty_incarnation TEXT NOT NULL,
  expected_lifecycle_state TEXT NOT NULL,
  observed_input_surface TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  expected_graph_revision INTEGER,
  state TEXT NOT NULL CHECK(state IN (
    'accepted', 'queued', 'written_to_pty', 'acknowledged', 'rejected',
    'superseded', 'delivery_unknown'
  )),
  bytes_written INTEGER NOT NULL DEFAULT 0,
  enter_written INTEGER NOT NULL DEFAULT 0,
  acknowledged_graph_revision INTEGER,
  superseded_by_command_id TEXT,
  rejection_code TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(lease_id) REFERENCES maestro_terminal_leases(id),
  UNIQUE(lease_id, enqueue_sequence)
);
CREATE INDEX IF NOT EXISTS idx_maestro_terminal_input_pending
  ON maestro_terminal_input_receipts(lease_id, state, enqueue_sequence);

CREATE TABLE IF NOT EXISTS maestro_coordinator_handoff_receipts (
  request_id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN (
    'reserved', 'spawned', 'capsule_delivery_acknowledged', 'coordinator_claimed',
    'authority_committed', 'predecessor_reconciled', 'blocked', 'outcome_unknown'
  )),
  predecessor_lease_id TEXT,
  successor_lease_id TEXT NOT NULL,
  successor_terminal_handle TEXT,
  successor_tab_id TEXT,
  successor_pty_incarnation TEXT,
  capsule_digest TEXT NOT NULL,
  input_idempotency_key TEXT NOT NULL,
  claimed_generation INTEGER NOT NULL,
  expected_graph_revision INTEGER NOT NULL,
  observed_graph_revision INTEGER,
  blocked_code TEXT,
  predecessor_retained INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(predecessor_lease_id) REFERENCES maestro_terminal_leases(id),
  FOREIGN KEY(successor_lease_id) REFERENCES maestro_terminal_leases(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_maestro_coordinator_handoff_generation
  ON maestro_coordinator_handoff_receipts(run_id, claimed_generation);
`
}
