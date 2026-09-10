-- Exact sqlite_master from f7d20593e3, initialized in memory.
CREATE TABLE coordinator_runs (
  id                  TEXT PRIMARY KEY,
  spec                TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'idle'
    CHECK(status IN ('idle', 'running', 'completed', 'failed')),
  coordinator_handle  TEXT NOT NULL,
  poll_interval_ms    INTEGER NOT NULL DEFAULT 2000,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at        TEXT,
  scheduler_lost_at   TEXT
);

CREATE TABLE decision_gates (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL DEFAULT 'run_legacy_local',
  task_id       TEXT NOT NULL,
  question      TEXT NOT NULL,
  options       TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'resolved', 'timeout')),
  resolution    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at   TEXT
);

CREATE TABLE deliveries (
  id                    TEXT PRIMARY KEY,
  run_id                TEXT NOT NULL,
  consumer_generation   INTEGER NOT NULL,
  message_ids           TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'outstanding'
    CHECK(status IN ('outstanding', 'acknowledged', 'fenced')),
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  acknowledged_at       TEXT
);

CREATE TABLE dispatch_contexts (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL DEFAULT 'run_legacy_local',
  task_id             TEXT NOT NULL,
  contract_version    INTEGER NOT NULL DEFAULT 1,
  launch_token_hash   TEXT,
  assignee_handle     TEXT,
  assignee_pane_key   TEXT,
  capability_hash     TEXT,
  process_incarnation TEXT,
  capability_revoked_at TEXT,
  status              TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'dispatched', 'completed', 'failed', 'circuit_broken')),
  failure_count       INTEGER NOT NULL DEFAULT 0,
  last_failure        TEXT,
  -- Why the process is gone, when Orca could establish it. See TerminalExitCause.
  termination_reason  TEXT,
  -- Nesting depth: a root coordinator's worker is 1, its worker's worker is 2.
  -- Defaults to 1 so an unstamped row fails closed rather than reading as a root.
  depth               INTEGER NOT NULL DEFAULT 1,
  dispatched_at       TEXT,
  completed_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  last_heartbeat_at   TEXT
);

CREATE TABLE federated_dispatches (
  dispatch_id             TEXT PRIMARY KEY,
  environment_id          TEXT NOT NULL,
  environment_name        TEXT NOT NULL,
  peer_fingerprint        TEXT NOT NULL,
  remote_runtime_epoch    TEXT,
  protocol_version        INTEGER NOT NULL DEFAULT 1,
  remote_worktree_id      TEXT,
  remote_terminal_handle  TEXT,
  to_home_imported_sequence INTEGER NOT NULL DEFAULT 0,
  to_home_acknowledged_sequence INTEGER NOT NULL DEFAULT 0,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE federation_relay_items (
  dispatch_id   TEXT NOT NULL,
  direction     TEXT NOT NULL CHECK(direction IN ('to_home', 'to_worker')),
  sequence      INTEGER NOT NULL,
  message_id    TEXT NOT NULL,
  kind          TEXT NOT NULL,
  payload       TEXT NOT NULL,
  byte_count    INTEGER NOT NULL,
  acked_at      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (dispatch_id, direction, sequence),
  UNIQUE (dispatch_id, direction, message_id)
);

CREATE TABLE legacy_adoptions (
      source_run_id        TEXT PRIMARY KEY,
      adopted_run_id       TEXT UNIQUE NOT NULL,
      scheduler_state_lost INTEGER NOT NULL,
      adopted_at           TEXT NOT NULL DEFAULT (datetime('now'))
    );

CREATE TABLE legacy_compatibility_principals (
      id                  TEXT PRIMARY KEY,
      run_id              TEXT NOT NULL,
      dispatch_id         TEXT,
      role                TEXT NOT NULL CHECK(role IN ('worker', 'coordinator')),
      host_scope          TEXT NOT NULL,
      terminal_handle     TEXT NOT NULL,
      pane_key            TEXT NOT NULL,
      launch_token_hash   TEXT NOT NULL,
      process_incarnation TEXT,
      status              TEXT NOT NULL
        CHECK(status IN ('committed', 'settled', 'revoked')),
      CHECK(
        (role = 'worker' AND dispatch_id IS NOT NULL) OR
        (role = 'coordinator' AND dispatch_id IS NULL)
      ),
      UNIQUE(role, run_id, dispatch_id)
    );

CREATE TABLE legacy_mail_receipts (
      principal_id    TEXT NOT NULL,
      message_id      TEXT NOT NULL,
      acknowledged_at TEXT,
      PRIMARY KEY(principal_id, message_id)
    );

CREATE TABLE legacy_operation_receipts (
      principal_id   TEXT NOT NULL,
      operation_key  TEXT NOT NULL,
      method         TEXT NOT NULL,
      payload_hash   TEXT NOT NULL,
      effect_id      TEXT NOT NULL,
      response_json  TEXT NOT NULL,
      completed_at   TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY(principal_id, operation_key)
    );

CREATE TABLE maestro_bootstrap_records (
  mutation_id TEXT PRIMARY KEY,
  execution_host_id TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  run_id TEXT NOT NULL,
  request_json TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE maestro_browser_profile_consents (
  consent_id TEXT PRIMARY KEY,
  execution_host_id TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE maestro_browser_surfaces (
  surface_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE,
  execution_host_id TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  run_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  owner_principal TEXT NOT NULL,
  ownership TEXT NOT NULL CHECK(ownership IN ('harness', 'user')),
  browser_page_id TEXT,
  navigation_url TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN (
    'reserved', 'creating', 'active', 'retained', 'release_pending',
    'released', 'outcome_unknown', 'unavailable'
  )),
  retention TEXT NOT NULL CHECK(retention IN ('release_when_settled', 'retain')),
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE maestro_context_snapshots (
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

CREATE TABLE maestro_coordinator_handoff_receipts (
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

CREATE TABLE maestro_delegation_intents (
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

CREATE TABLE maestro_deltas (
  execution_host_id TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  delta_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (execution_host_id, workspace_key, revision)
);

CREATE TABLE maestro_documents (
  execution_host_id TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  run_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0,
  document_json TEXT NOT NULL DEFAULT '{"nodes":{}}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (execution_host_id, workspace_key)
);

CREATE TABLE maestro_human_reviews (
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

CREATE TABLE maestro_mutation_receipts (
  execution_host_id TEXT NOT NULL,
  workspace_key TEXT NOT NULL,
  mutation_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  receipt_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (execution_host_id, workspace_key, mutation_id)
);

CREATE TABLE maestro_run_projections (
  run_id TEXT PRIMARY KEY,
  home_execution_host_id TEXT NOT NULL,
  home_workspace_key TEXT NOT NULL,
  execution_execution_host_id TEXT NOT NULL,
  execution_workspace_key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  view_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE maestro_terminal_input_receipts (
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

CREATE TABLE maestro_terminal_lease_transfer_receipts (
  request_id TEXT PRIMARY KEY,
  receipt_json TEXT NOT NULL,
  mutation_caller_fingerprint TEXT,
  mutation_request_id TEXT,
  mutation_method TEXT,
  mutation_payload_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE maestro_terminal_leases (
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

CREATE TABLE messages (
  id            TEXT NOT NULL,
  run_id        TEXT NOT NULL DEFAULT 'run_legacy_local',
  delivery_contract TEXT NOT NULL DEFAULT 'current_delivery'
    CHECK(delivery_contract IN ('legacy_direct', 'current_delivery', 'audit_only')),
  from_handle   TEXT NOT NULL,
  to_handle     TEXT NOT NULL,
  subject       TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  type          TEXT NOT NULL DEFAULT 'status'
    CHECK(type IN (
      'status', 'dispatch', 'worker_done', 'merge_ready',
      'escalation', 'handoff', 'decision_gate', 'question', 'heartbeat'
    )),
  priority      TEXT NOT NULL DEFAULT 'normal'
    CHECK(priority IN ('normal', 'high', 'urgent')),
  thread_id     TEXT,
  payload       TEXT,
  read          INTEGER NOT NULL DEFAULT 0,
  sequence      INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at  TEXT,
  sender_pane_key TEXT
);

CREATE TABLE mutation_caller_identities (
  transport           TEXT PRIMARY KEY,
  caller_fingerprint  TEXT NOT NULL UNIQUE
);

CREATE TABLE mutation_receipt_ledger (
      singleton     INTEGER PRIMARY KEY CHECK(singleton = 1),
      receipt_count INTEGER NOT NULL CHECK(receipt_count >= 0)
    );

CREATE TABLE mutation_receipts (
  caller_fingerprint  TEXT NOT NULL,
  request_id          TEXT NOT NULL,
  method              TEXT NOT NULL,
  payload_hash        TEXT NOT NULL,
  state               TEXT NOT NULL DEFAULT 'pending'
    CHECK(state IN ('pending', 'completed')),
  receipt             TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (caller_fingerprint, request_id)
);

CREATE TABLE question_threads (
      message_id                TEXT PRIMARY KEY,
      run_id                    TEXT NOT NULL,
      dispatch_id               TEXT NOT NULL,
      asker_handle              TEXT NOT NULL,
      status                    TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending', 'answered', 'closed')),
      answer_message_id         TEXT,
      answer_body               TEXT,
      answered_by_generation    INTEGER,
      created_at                TEXT NOT NULL DEFAULT (datetime('now')),
      answered_at               TEXT,
      closed_at                 TEXT
    );

CREATE TABLE remote_dispatch_attachments (
  dispatch_id             TEXT PRIMARY KEY,
  task_id                 TEXT NOT NULL,
  home_peer_fingerprint   TEXT NOT NULL,
  protocol_version        INTEGER NOT NULL DEFAULT 1,
  runtime_epoch           TEXT NOT NULL,
  capability_hash         TEXT,
  pane_key                TEXT,
  process_incarnation     TEXT,
  state                   TEXT NOT NULL DEFAULT 'starting'
    CHECK(state IN (
      'starting', 'ready', 'start_unknown', 'failed', 'succeeded',
      'stopping', 'stop_unknown', 'stopped', 'abandoned'
    )),
  stage                   TEXT NOT NULL DEFAULT 'accepted',
  worktree_id             TEXT,
  terminal_handle         TEXT,
  setup_state             TEXT NOT NULL DEFAULT 'not_applicable',
  effects                 TEXT NOT NULL DEFAULT '[]',
  residual_resources      TEXT NOT NULL DEFAULT '[]',
  to_worker_imported_sequence INTEGER NOT NULL DEFAULT 0,
  -- Nesting depth of the worker this attachment represents. Propagated from the
  -- Run home; absent from an old client means 1, which fails closed.
  depth                   INTEGER NOT NULL DEFAULT 1,
  last_error              TEXT,
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE remote_questions (
  message_id        TEXT PRIMARY KEY,
  dispatch_id       TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'answered', 'closed')),
  answer_message_id TEXT,
  answer_body       TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  answered_at       TEXT
);

CREATE TABLE run_coordinator_handles (
  run_id          TEXT NOT NULL,
  terminal_handle TEXT NOT NULL,
  first_bound_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (run_id, terminal_handle)
);

CREATE TABLE runs (
  id                    TEXT PRIMARY KEY,
  objective             TEXT NOT NULL,
  home_database         TEXT NOT NULL DEFAULT 'this_database',
  coordinator_handle    TEXT,
  coordinator_pane_key  TEXT,
  consumer_generation   INTEGER NOT NULL DEFAULT 0,
  legacy                INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL DEFAULT 'run_legacy_local',
  parent_id     TEXT,
  created_by_terminal_handle TEXT,
  created_by_pane_key TEXT,
  created_by_process_incarnation TEXT,
  created_by_run_generation INTEGER,
  task_title    TEXT,
  display_name  TEXT,
  spec          TEXT NOT NULL,
  purpose       TEXT NOT NULL DEFAULT 'deliverable'
    CHECK(purpose IN ('deliverable', 'operational')),
  operational_outcome TEXT
    CHECK(operational_outcome IN ('successful', 'failed', 'superseded', 'unverifiable')),
  successor_task_id TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN (
      'pending', 'ready', 'dispatched',
      'completed', 'failed', 'blocked'
    )),
  deps          TEXT NOT NULL DEFAULT '[]',
  result        TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at  TEXT
);

CREATE TABLE terminal_close_intents (
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

CREATE TABLE worker_dispatches (
  dispatch_id            TEXT PRIMARY KEY,
  runtime_epoch          TEXT,
  state                  TEXT NOT NULL DEFAULT 'starting'
    CHECK(state IN (
      'starting', 'ready', 'start_unknown', 'failed', 'succeeded',
      'stopping', 'stop_unknown', 'stopped', 'abandoned'
    )),
  stage                  TEXT NOT NULL DEFAULT 'accepted',
  worktree_id            TEXT,
  agent_terminal_handle  TEXT,
  setup_state            TEXT NOT NULL DEFAULT 'not_applicable',
  effects                TEXT NOT NULL DEFAULT '[]',
  residual_resources     TEXT NOT NULL DEFAULT '[]',
  start_options          TEXT NOT NULL DEFAULT '{}',
  last_error             TEXT,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE worker_terminal_archives (
  dispatch_id   TEXT PRIMARY KEY,
  resource_id   TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK(kind IN ('transcript_pin', 'terminal_tail')),
  content       TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE worker_terminal_resources (
  id                       TEXT PRIMARY KEY,
  origin_dispatch_id       TEXT NOT NULL,
  owner_dispatch_id        TEXT NOT NULL,
  prior_owner_dispatch_ids TEXT NOT NULL DEFAULT '[]',
  worktree_id              TEXT,
  terminal_handle          TEXT NOT NULL,
  pane_key                 TEXT,
  process_incarnation      TEXT,
  host_scope               TEXT,
  ownership_state          TEXT NOT NULL DEFAULT 'owned'
    CHECK(ownership_state IN ('owned', 'transferred', 'user_owned', 'external', 'released')),
  release_state            TEXT NOT NULL DEFAULT 'not_requested'
    CHECK(release_state IN (
      'not_requested', 'retained', 'retained_for_review',
      'requested', 'releasing', 'released', 'unknown'
    )),
  retained_reason          TEXT,
  retention_owner          TEXT,
  retention_expires_at     TEXT,
  review_id                TEXT,
  release_requested_at     TEXT,
  release_completed_at     TEXT,
  release_error            TEXT,
  archive_source           TEXT,
  archive_status           TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_deliveries_one_outstanding
  ON deliveries(run_id) WHERE status = 'outstanding';

CREATE INDEX idx_deliveries_run_created
  ON deliveries(run_id, created_at);

CREATE INDEX idx_dispatch_active_assignee_handle
          ON dispatch_contexts(assignee_handle)
          WHERE assignee_handle IS NOT NULL AND status IN ('pending', 'dispatched');

CREATE INDEX idx_dispatch_active_assignee_pane_key
        ON dispatch_contexts(assignee_pane_key)
        WHERE assignee_pane_key IS NOT NULL AND status IN ('pending', 'dispatched');

CREATE INDEX idx_dispatch_active_run_assignee_handle
        ON dispatch_contexts(run_id, assignee_handle)
        WHERE assignee_handle IS NOT NULL AND status IN ('pending', 'dispatched');

CREATE INDEX idx_dispatch_active_run_pane_leaf
        ON dispatch_contexts(run_id, substr(assignee_pane_key, instr(assignee_pane_key, ':') + 1))
        WHERE assignee_pane_key IS NOT NULL AND status IN ('pending', 'dispatched');

CREATE INDEX idx_dispatch_assignee_handle ON dispatch_contexts(assignee_handle);

CREATE INDEX idx_dispatch_assignee_pane_leaf
        ON dispatch_contexts(substr(assignee_pane_key, instr(assignee_pane_key, ':') + 1))
        WHERE assignee_pane_key IS NOT NULL AND status IN ('pending', 'dispatched');

CREATE INDEX idx_dispatch_run_status ON dispatch_contexts(run_id, status);

CREATE INDEX idx_dispatch_status ON dispatch_contexts(status);

CREATE INDEX idx_dispatch_task ON dispatch_contexts(task_id);

CREATE INDEX idx_federation_relay_pending
  ON federation_relay_items(dispatch_id, direction, acked_at, sequence);

CREATE INDEX idx_gates_run_status ON decision_gates(run_id, status);

CREATE INDEX idx_gates_status ON decision_gates(status);

CREATE INDEX idx_gates_task ON decision_gates(task_id);

CREATE INDEX idx_inbox ON messages(to_handle, read);

CREATE UNIQUE INDEX idx_legacy_principal_coordinator
      ON legacy_compatibility_principals(run_id)
      WHERE role = 'coordinator';

CREATE UNIQUE INDEX idx_legacy_principal_dispatch
      ON legacy_compatibility_principals(dispatch_id)
      WHERE role = 'worker';

CREATE INDEX idx_maestro_bootstrap_records_workspace
  ON maestro_bootstrap_records(execution_host_id, workspace_key, updated_at);

CREATE UNIQUE INDEX idx_maestro_browser_profile_consent_active
  ON maestro_browser_profile_consents(
    execution_host_id, workspace_key, run_id, task_id, attempt_id, profile_id
  ) WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX idx_maestro_browser_surface_attempt
  ON maestro_browser_surfaces(execution_host_id, workspace_key, run_id, task_id, attempt_id)
  WHERE state NOT IN ('released');

CREATE UNIQUE INDEX idx_maestro_browser_surface_live_page
  ON maestro_browser_surfaces(execution_host_id, workspace_key, browser_page_id)
  WHERE browser_page_id IS NOT NULL AND state NOT IN ('released');

CREATE INDEX idx_maestro_browser_surface_reconciliation
  ON maestro_browser_surfaces(state, retention, ownership, updated_at);

CREATE INDEX idx_maestro_context_snapshots_run
  ON maestro_context_snapshots(execution_host_id, workspace_key, run_id, released_at);

CREATE UNIQUE INDEX idx_maestro_coordinator_handoff_generation
  ON maestro_coordinator_handoff_receipts(run_id, claimed_generation);

CREATE INDEX idx_maestro_delegation_intents_scope
  ON maestro_delegation_intents(execution_host_id, workspace_key, run_id, state, created_at);

CREATE INDEX idx_maestro_deltas_cursor
  ON maestro_deltas(execution_host_id, workspace_key, revision);

CREATE INDEX idx_maestro_human_reviews_run
  ON maestro_human_reviews(execution_host_id, workspace_key, run_id, updated_at);

CREATE INDEX idx_maestro_run_projections_execution
      ON maestro_run_projections(
        execution_execution_host_id, execution_workspace_key, updated_at
      );

CREATE INDEX idx_maestro_run_projections_home
      ON maestro_run_projections(home_execution_host_id, home_workspace_key, updated_at);

CREATE INDEX idx_maestro_terminal_input_pending
  ON maestro_terminal_input_receipts(lease_id, state, enqueue_sequence);

CREATE UNIQUE INDEX idx_maestro_terminal_lease_transfer_mutation
  ON maestro_terminal_lease_transfer_receipts(
    mutation_caller_fingerprint, mutation_request_id, mutation_method, mutation_payload_hash
  )
  WHERE mutation_caller_fingerprint IS NOT NULL AND mutation_request_id IS NOT NULL
    AND mutation_method IS NOT NULL AND mutation_payload_hash IS NOT NULL;

CREATE UNIQUE INDEX idx_maestro_terminal_leases_coordinator_generation
  ON maestro_terminal_leases(run_id, coordinator_generation)
  WHERE role = 'coordinator';

CREATE INDEX idx_maestro_terminal_leases_lifecycle
  ON maestro_terminal_leases(run_id, lifecycle_state, role);

CREATE UNIQUE INDEX idx_maestro_terminal_leases_live_terminal_owner
  ON maestro_terminal_leases(execution_host_id, workspace_key, terminal_handle, pty_incarnation)
  WHERE terminal_handle IS NOT NULL AND pty_incarnation IS NOT NULL
    AND lifecycle_state NOT IN ('released', 'superseded', 'archived');

CREATE UNIQUE INDEX idx_maestro_terminal_leases_worker_attempt
  ON maestro_terminal_leases(run_id, task_id, attempt_id)
  WHERE role = 'worker' AND attempt_id IS NOT NULL AND lifecycle_state != 'superseded';

CREATE UNIQUE INDEX idx_maestro_terminal_leases_worker_resource
  ON maestro_terminal_leases(worker_terminal_resource_id)
  WHERE worker_terminal_resource_id IS NOT NULL AND lifecycle_state != 'superseded';

CREATE INDEX idx_messages_delivery_contract
      ON messages(run_id, delivery_contract, to_handle, read, sequence);

CREATE UNIQUE INDEX idx_messages_id ON messages(id);

CREATE INDEX idx_messages_run_sequence ON messages(run_id, sequence);

CREATE INDEX idx_messages_undelivered_direct_run
      ON messages(run_id, to_handle, sequence)
      WHERE read = 0 AND delivered_at IS NULL
        AND delivery_contract = 'current_delivery';

CREATE INDEX idx_messages_undelivered_inbox
        ON messages(to_handle, read, delivered_at, sequence)
    ;

CREATE INDEX idx_messages_unread_current_inbox
      ON messages(to_handle, sequence)
      WHERE read = 0 AND delivery_contract = 'current_delivery';

CREATE INDEX idx_messages_unread_current_inbox_type
      ON messages(to_handle, type, sequence)
      WHERE read = 0 AND delivery_contract = 'current_delivery';

CREATE INDEX idx_messages_unread_current_run_type
      ON messages(run_id, to_handle, type, sequence)
      WHERE read = 0 AND delivery_contract = 'current_delivery';

CREATE INDEX idx_mutation_receipts_completed_updated
      ON mutation_receipts(updated_at) WHERE state = 'completed';

CREATE INDEX idx_questions_dispatch_status
      ON question_threads(dispatch_id, status);

CREATE INDEX idx_remote_dispatch_attachments_active_pane
          ON remote_dispatch_attachments(pane_key)
          WHERE state IN ('starting', 'ready', 'start_unknown', 'stopping', 'stop_unknown');

CREATE INDEX idx_remote_dispatch_attachments_active_pane_suffix
          ON remote_dispatch_attachments(substr(pane_key, instr(pane_key, ':') + 1))
          WHERE state IN ('starting', 'ready', 'start_unknown', 'stopping', 'stop_unknown')
            AND pane_key IS NOT NULL;

CREATE INDEX idx_remote_questions_dispatch_status
  ON remote_questions(dispatch_id, status);

CREATE INDEX idx_run_coordinator_handles_handle
  ON run_coordinator_handles(terminal_handle, run_id);

CREATE INDEX idx_runs_coordinator_pane ON runs(coordinator_pane_key);

CREATE INDEX idx_runs_coordinator_pane_leaf
  ON runs(substr(coordinator_pane_key, instr(coordinator_pane_key, ':') + 1))
  WHERE coordinator_pane_key IS NOT NULL;

CREATE INDEX idx_tasks_parent ON tasks(parent_id);

CREATE INDEX idx_tasks_run_status ON tasks(run_id, status);

CREATE INDEX idx_tasks_status ON tasks(status);

CREATE INDEX idx_terminal_close_intents_pending
  ON terminal_close_intents(state, updated_at);

CREATE INDEX idx_thread ON messages(thread_id);

CREATE INDEX idx_worker_terminal_resources_handle
  ON worker_terminal_resources(terminal_handle);

CREATE INDEX idx_worker_terminal_resources_identity
  ON worker_terminal_resources(process_incarnation, host_scope);

CREATE UNIQUE INDEX idx_worker_terminal_resources_owner
  ON worker_terminal_resources(owner_dispatch_id);

CREATE INDEX idx_worker_terminal_resources_pane
  ON worker_terminal_resources(pane_key);

CREATE INDEX idx_worker_terminal_resources_release
  ON worker_terminal_resources(release_state);

CREATE TRIGGER mutation_receipts_count_delete
    AFTER DELETE ON mutation_receipts
    BEGIN
      UPDATE mutation_receipt_ledger
      SET receipt_count = receipt_count - 1
      WHERE singleton = 1;
    END;

CREATE TRIGGER mutation_receipts_count_insert
    AFTER INSERT ON mutation_receipts
    BEGIN
      UPDATE mutation_receipt_ledger
      SET receipt_count = receipt_count + 1
      WHERE singleton = 1;
    END;

CREATE TRIGGER trg_messages_route_coordinator_mail
      AFTER INSERT ON messages
      WHEN NEW.read = 0 AND NEW.delivery_contract = 'current_delivery'
        AND EXISTS (
          SELECT 1 FROM runs
          WHERE runs.id = NEW.run_id AND runs.legacy = 0
        )
        AND EXISTS (
          SELECT 1 FROM run_coordinator_handles
          WHERE run_id = NEW.run_id AND terminal_handle = NEW.to_handle
        )
        AND NOT EXISTS (
          SELECT 1 FROM dispatch_contexts
          WHERE run_id = NEW.run_id AND assignee_handle = NEW.to_handle
            AND status IN ('pending', 'dispatched')
        )
      BEGIN
        UPDATE messages SET to_handle = 'run:' || NEW.run_id WHERE sequence = NEW.sequence;
      END;

CREATE TRIGGER trg_runs_forget_coordinator_handles
AFTER DELETE ON runs
BEGIN
  DELETE FROM run_coordinator_handles WHERE run_id = OLD.id;
END;

CREATE TRIGGER trg_runs_remember_coordinator_insert
AFTER INSERT ON runs
WHEN NEW.legacy = 0 AND NEW.coordinator_handle IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
  VALUES (NEW.id, NEW.coordinator_handle);
END;

CREATE TRIGGER trg_runs_remember_coordinator_update
AFTER UPDATE OF coordinator_handle ON runs
WHEN NEW.legacy = 0 AND NEW.coordinator_handle IS NOT NULL
BEGIN
  INSERT OR IGNORE INTO run_coordinator_handles (run_id, terminal_handle)
  VALUES (NEW.id, NEW.coordinator_handle);
END;
PRAGMA user_version = 36;
