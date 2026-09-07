import { CURRENT_CONTRACT_VERSION, LEGACY_RUN_ID } from '../contract-constants'
import {
  REMOTE_ATTACHMENT_PANE_KEY_MATCH_SUFFIX_SQL,
  RUN_PANE_KEY_MATCH_SUFFIX_SQL
} from '../pane-key-match'
import { potentiallyLiveRemoteAttachmentSql } from '../federation/remote-attachment-liveness'

// Additive tables outlive v30 writers, so legacy parent deletes must clean their rows too.
export const ADDITIVE_LIFECYCLE_DELETE_TRIGGERS_SQL = `
CREATE TRIGGER IF NOT EXISTS trg_tasks_delete_additive_lifecycle
AFTER DELETE ON tasks
BEGIN
  DELETE FROM attempt_observation_facts WHERE task_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_dispatches_delete_additive_lifecycle
AFTER DELETE ON dispatch_contexts
BEGIN
  DELETE FROM attempt_observation_facts WHERE dispatch_id = OLD.id;
END;
`

export function createGraphTablesSql(): string {
  return `
CREATE TABLE IF NOT EXISTS federated_dispatches (
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

CREATE TABLE IF NOT EXISTS remote_dispatch_attachments (
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

-- Why five states: 'start_unknown', 'stopping', and 'stop_unknown' do not
-- establish process exit, and a potentially-live worker must still count as a
-- nesting parent. See docs/reference/ssh-execution-boundary.md.
CREATE INDEX IF NOT EXISTS idx_remote_dispatch_attachments_active_pane
  ON remote_dispatch_attachments(pane_key)
  WHERE ${potentiallyLiveRemoteAttachmentSql()};
CREATE INDEX IF NOT EXISTS idx_remote_dispatch_attachments_active_pane_suffix
  ON remote_dispatch_attachments(${REMOTE_ATTACHMENT_PANE_KEY_MATCH_SUFFIX_SQL})
  WHERE ${potentiallyLiveRemoteAttachmentSql()}
    AND pane_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS federation_relay_items (
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

CREATE INDEX IF NOT EXISTS idx_federation_relay_pending
  ON federation_relay_items(dispatch_id, direction, acked_at, sequence);

CREATE TABLE IF NOT EXISTS remote_questions (
  message_id        TEXT PRIMARY KEY,
  dispatch_id       TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'answered', 'closed')),
  answer_message_id TEXT,
  answer_body       TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  answered_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_remote_questions_dispatch_status
  ON remote_questions(dispatch_id, status);

CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL DEFAULT '${LEGACY_RUN_ID}',
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

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);

CREATE TABLE IF NOT EXISTS dispatch_contexts (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL DEFAULT '${LEGACY_RUN_ID}',
  task_id             TEXT NOT NULL,
  contract_version    INTEGER NOT NULL DEFAULT ${CURRENT_CONTRACT_VERSION},
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

CREATE INDEX IF NOT EXISTS idx_dispatch_task ON dispatch_contexts(task_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_status ON dispatch_contexts(status);
CREATE INDEX IF NOT EXISTS idx_dispatch_assignee_handle ON dispatch_contexts(assignee_handle);

${ADDITIVE_LIFECYCLE_DELETE_TRIGGERS_SQL}

CREATE TABLE IF NOT EXISTS decision_gates (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL DEFAULT '${LEGACY_RUN_ID}',
  task_id       TEXT NOT NULL,
  question      TEXT NOT NULL,
  options       TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'resolved', 'timeout')),
  resolution    TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_gates_task ON decision_gates(task_id);
CREATE INDEX IF NOT EXISTS idx_gates_status ON decision_gates(status);

CREATE INDEX IF NOT EXISTS idx_runs_coordinator_pane_leaf
  ON runs(${RUN_PANE_KEY_MATCH_SUFFIX_SQL})
  WHERE coordinator_pane_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS coordinator_runs (
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
  `
}
