-- Exact sqlite_master from 5a46703ce5, initialized in memory.
CREATE TABLE attempt_observation_facts (
  id                    TEXT PRIMARY KEY,
  dispatch_id           TEXT NOT NULL,
  task_id               TEXT NOT NULL,
  sequence              INTEGER NOT NULL,
  authority_id          TEXT NOT NULL,
  authority_clock       TEXT NOT NULL,
  facet                 TEXT NOT NULL,
  payload               TEXT NOT NULL,
  source_observed_at    INTEGER,
  execution_received_at INTEGER,
  home_received_at      INTEGER NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(dispatch_id, sequence)
);

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
  -- Default keeps a downgraded binary's column-less INSERT working against a v34 database.
  mailbox_handle        TEXT NOT NULL DEFAULT '',
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
  -- R1 identity facts; nullable when legacy provenance was never proven.
  retry_of_dispatch_id TEXT,
  creator_dispatch_id TEXT,
  -- Who created this row. A row whose creator is its own assignee is bookkeeping, not delegation,
  -- so it must not count as a nesting parent. Null on rows written before v37 and for Orca's loop.
  creator_handle      TEXT,
  creator_pane_key    TEXT,
  host_scope          TEXT,
  status              TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'dispatched', 'completed', 'failed', 'circuit_broken')),
  failure_count       INTEGER NOT NULL DEFAULT 0,
  last_failure        TEXT,
  -- Why the process is gone, when Orca could establish it. See TerminalExitCause.
  termination_reason  TEXT,
  -- Nesting depth: a root coordinator's worker is 1, its worker's worker is 2.
  -- Defaults to 1 so an unstamped row fails closed rather than reading as a root.
  depth               INTEGER NOT NULL DEFAULT 1,
  -- Bumped whenever the Dispatch is re-pointed at a pane/process, fencing the prior consumer's
  -- outstanding dispatch mailbox Delivery.
  consumer_generation INTEGER NOT NULL DEFAULT 0,
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
  sender_pane_key TEXT,
  pointer_enter_pending INTEGER NOT NULL DEFAULT 0,
  pointer_pty_id TEXT,
  pointer_process_incarnation TEXT
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
  -- Its own counter: a federated worker host has no dispatch_contexts row to borrow one from.
  consumer_generation     INTEGER NOT NULL DEFAULT 0,
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
  endpoint_id              TEXT,
  endpoint_incarnation     TEXT,
  host_scope               TEXT,
  ownership_state          TEXT NOT NULL DEFAULT 'owned'
    CHECK(ownership_state IN ('owned', 'transferred', 'user_owned', 'external', 'released')),
  release_state            TEXT NOT NULL DEFAULT 'not_requested'
    CHECK(release_state IN (
      'not_requested', 'retained', 'requested', 'releasing', 'released', 'unknown'
    )),
  retained_reason          TEXT,
  release_requested_at     TEXT,
  release_completed_at     TEXT,
  release_error            TEXT,
  recovery_attempt_count   INTEGER NOT NULL DEFAULT 0,
  last_recovery_at         TEXT,
  archive_source           TEXT,
  archive_status           TEXT,
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_attempt_observation_facts_projection
  ON attempt_observation_facts(dispatch_id, facet, sequence);

CREATE UNIQUE INDEX idx_deliveries_one_outstanding
        ON deliveries(mailbox_handle) WHERE status = 'outstanding' AND mailbox_handle != '';

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

CREATE INDEX idx_messages_delivery_contract
      ON messages(run_id, delivery_contract, to_handle, read, sequence);

CREATE UNIQUE INDEX idx_messages_id ON messages(id);

CREATE INDEX idx_messages_pending_pointer_enter
        ON messages(to_handle, sequence)
        WHERE read = 0 AND pointer_enter_pending > 0;

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

CREATE TRIGGER trg_dispatches_delete_additive_lifecycle
AFTER DELETE ON dispatch_contexts
BEGIN
  DELETE FROM attempt_observation_facts WHERE dispatch_id = OLD.id;
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

CREATE TRIGGER trg_tasks_delete_additive_lifecycle
AFTER DELETE ON tasks
BEGIN
  DELETE FROM attempt_observation_facts WHERE task_id = OLD.id;
END;
PRAGMA user_version = 38;
