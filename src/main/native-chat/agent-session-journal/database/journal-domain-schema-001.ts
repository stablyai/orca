import { JOURNAL_DOMAIN_SCHEMA_001_OUTLINE } from './journal-domain-schema-001-outline'
import { JOURNAL_DOMAIN_SCHEMA_001_INDEXES } from './journal-domain-schema-001-indexes'

export const JOURNAL_DOMAIN_SCHEMA_001 = `
CREATE TABLE agent_session_records (
  session_id TEXT PRIMARY KEY,
  record_json TEXT NOT NULL,
  adopted_native_id TEXT GENERATED ALWAYS AS (
    CASE WHEN json_valid(record_json) THEN COALESCE(
      json_extract(record_json,'$.providerHandleChain[#-1].handle.nativeId'),
      json_extract(record_json,'$.providerHandleChain[#-1].handle.sessionId'),
      json_extract(record_json,'$.providerHandleChain[#-1].handle.threadId')) END
  ) VIRTUAL
);
CREATE INDEX agent_session_records_adopted_native ON agent_session_records(adopted_native_id);
CREATE TABLE agent_session_operations (
  operation_key TEXT PRIMARY KEY,
  row_json TEXT NOT NULL,
  operation_id TEXT GENERATED ALWAYS AS (
    CASE WHEN json_valid(row_json) THEN json_extract(row_json, '$.operationId') END
  ) VIRTUAL,
  expires_at INTEGER GENERATED ALWAYS AS (
    CASE WHEN json_valid(row_json) THEN json_extract(row_json, '$.expiresAt') END
  ) VIRTUAL
);
CREATE INDEX agent_session_operations_identity ON agent_session_operations(operation_id);
CREATE INDEX agent_session_operations_expiry ON agent_session_operations(expires_at,operation_key);
CREATE TABLE agent_session_retired_claim_keys (
  key_id TEXT PRIMARY KEY,
  retired_at INTEGER NOT NULL
);
CREATE TABLE agent_session_tabs (
  tab_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  position INTEGER NOT NULL
);
CREATE TABLE agent_session_store_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE agent_session_command_receipts (
  operation_id TEXT NOT NULL,
  session_id TEXT NOT NULL REFERENCES agent_session_records(session_id) ON DELETE CASCADE,
  caller_key TEXT NOT NULL,
  method TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  rejection_json TEXT,
  accepted_at INTEGER NOT NULL,
  PRIMARY KEY(operation_id, caller_key)
);
CREATE TABLE agent_session_attachment_claims (
  upload_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  PRIMARY KEY(upload_id, session_id)
);
CREATE TABLE agent_session_attachment_sweeps (
  upload_id TEXT NOT NULL PRIMARY KEY,
  started_at INTEGER NOT NULL
);

CREATE TABLE journal_chat_state (
  session_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  epoch TEXT,
  last_sequence INTEGER NOT NULL DEFAULT 0,
  retained_sequence INTEGER NOT NULL DEFAULT 0,
  highest_fence INTEGER NOT NULL DEFAULT 0,
  context_boundary INTEGER NOT NULL DEFAULT 0,
  last_activity_at INTEGER NOT NULL DEFAULT 0,
  derived_turn_item_id TEXT,
  history_origin_json TEXT,
  accepted_handover_sequence INTEGER NOT NULL DEFAULT 0,
  queue_revision INTEGER NOT NULL DEFAULT 0,
  submissions_revision INTEGER NOT NULL DEFAULT 0,
  queue_latest_stop_json TEXT,
  queue_manual_stop_json TEXT,
  queue_resumed_sequence INTEGER NOT NULL DEFAULT 0,
  queue_reopened_sequence INTEGER NOT NULL DEFAULT 0,
  queue_clear_sequence INTEGER,
  queue_clear_operation_id TEXT,
  queue_clear_lifted INTEGER NOT NULL DEFAULT 0,
  queue_failure_boundary INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE journal_queue_clear_members (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  message_id TEXT NOT NULL,
  PRIMARY KEY(session_id, epoch, message_id)
) WITHOUT ROWID;
CREATE TABLE journal_items (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  item_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  sequence_index INTEGER NOT NULL,
  owner_fence INTEGER NOT NULL,
  execution_owner INTEGER,
  hidden INTEGER NOT NULL DEFAULT 0,
  root INTEGER NOT NULL DEFAULT 1,
  subagent_row INTEGER NOT NULL DEFAULT 0,
  subagent_group_key TEXT,
  turn_marker INTEGER NOT NULL DEFAULT 0,
  wire_version INTEGER,
  wire_bytes INTEGER,
  turn_item_id TEXT,
  queue_command_turn INTEGER NOT NULL DEFAULT 0,
  queue_failed_outcome INTEGER NOT NULL DEFAULT 0,
  queue_failed_at INTEGER NOT NULL DEFAULT 0,
  queue_failure_witnessed_through INTEGER NOT NULL DEFAULT 0,
  queue_failure_report_turn_item_id TEXT,
  kind TEXT,
  message_role TEXT,
  turn_id TEXT,
  provider_turn_id TEXT,
  codex_thread_id TEXT,
  codex_turn_id TEXT,
  legacy_provider_item_key TEXT,
  opener_item_id TEXT,
  context_clear INTEGER NOT NULL DEFAULT 0,
  goal_transition INTEGER NOT NULL DEFAULT 0,
  producer_agent_id TEXT,
  producer_parent_ref TEXT,
  producer_attempt INTEGER,
  prompt INTEGER NOT NULL DEFAULT 0,
  signed_out INTEGER NOT NULL DEFAULT 0,
  lifecycle_state TEXT,
  live_work INTEGER NOT NULL DEFAULT 0,
  context_window INTEGER NOT NULL DEFAULT 0,
  unverified_end INTEGER NOT NULL DEFAULT 0,
  turn_completed_at REAL,
  command_entry INTEGER NOT NULL DEFAULT 0,
  assistant_prose INTEGER NOT NULL DEFAULT 0,
  turn_scope_kind TEXT,
  payload_json TEXT NOT NULL,
  wire_json TEXT,
  detail_json TEXT,
  outline_source_json TEXT,
  original_stop_note_json TEXT,
  placement_json TEXT,
  PRIMARY KEY(session_id, epoch, item_id)
);
CREATE TABLE journal_settlements (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  settlement_id TEXT NOT NULL,
  PRIMARY KEY(session_id, epoch, settlement_id)
) WITHOUT ROWID;
CREATE TABLE journal_input_end_observations (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  source_item_key TEXT NOT NULL,
  observation_json TEXT NOT NULL,
  PRIMARY KEY(session_id,epoch,source_item_key)
) WITHOUT ROWID;
CREATE TABLE journal_item_subagent_names (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  subagent_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  sequence_index INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  hidden INTEGER NOT NULL,
  PRIMARY KEY(session_id, epoch, subagent_id, item_id)
) WITHOUT ROWID;
CREATE TABLE journal_item_tombstones (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  item_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY(session_id, epoch, item_id)
) WITHOUT ROWID;
CREATE TABLE journal_removed_turns (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  PRIMARY KEY(session_id, epoch, turn_id)
) WITHOUT ROWID;
CREATE TABLE journal_item_aliases (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  provider_item_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  echo_declared INTEGER NOT NULL DEFAULT 0,
  echo_json TEXT,
  PRIMARY KEY(session_id, epoch, provider_item_id)
) WITHOUT ROWID;
CREATE TABLE journal_submission_attempts (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  message_id TEXT NOT NULL,
  attempt_sequence INTEGER NOT NULL,
  attempt_index INTEGER NOT NULL,
  current INTEGER NOT NULL CHECK(current IN (0,1)),
  item_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  submitted_at INTEGER NOT NULL,
  accepted_sequence INTEGER,
  submitted_sequence INTEGER,
  request_failure INTEGER NOT NULL DEFAULT 0,
  steer_turn_item_id TEXT,
  stopped_history INTEGER NOT NULL DEFAULT 0,
  covers_stopped_history INTEGER NOT NULL DEFAULT 0,
  fingerprint TEXT NOT NULL,
  dispatch_state TEXT NOT NULL,
  provider_item_id TEXT GENERATED ALWAYS AS (
    CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.providerItemId') END
  ) VIRTUAL,
  codex_thread_id TEXT,
  codex_turn_id TEXT,
  queued INTEGER NOT NULL DEFAULT 0,
  dispatch_fence INTEGER NOT NULL DEFAULT 0,
  signed_out INTEGER NOT NULL DEFAULT 0 CHECK(signed_out IN (0,1)),
  recovered INTEGER NOT NULL DEFAULT 0 CHECK(recovered IN (0,1)),
  candidate INTEGER NOT NULL DEFAULT 0,
  admitted_personal INTEGER NOT NULL DEFAULT 0 CHECK(admitted_personal IN (0,1)),
  echo_observed INTEGER NOT NULL DEFAULT 0 CHECK(echo_observed IN (0,1)),
  admission_body_json TEXT,
  admission_family_id TEXT,
  handover_fence INTEGER,
  facts_json TEXT NOT NULL DEFAULT '{}',
  outline_json TEXT,
  payload_json TEXT NOT NULL,
  PRIMARY KEY(session_id, epoch, message_id, attempt_sequence, attempt_index)
);
CREATE UNIQUE INDEX journal_submission_head ON journal_submission_attempts(session_id, epoch, message_id) WHERE current=1;
CREATE UNIQUE INDEX journal_submission_item ON journal_submission_attempts(session_id, epoch, item_id) WHERE current=1;
CREATE TABLE journal_send_receipts (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  message_id TEXT NOT NULL,
  cursor_sequence INTEGER NOT NULL DEFAULT 0,
  payload_json TEXT NOT NULL,
  PRIMARY KEY(session_id, epoch, message_id)
) WITHOUT ROWID;
CREATE TABLE journal_provider_activity (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  fence INTEGER NOT NULL,
  last_activity_at INTEGER NOT NULL,
  PRIMARY KEY(session_id, epoch, fence)
) WITHOUT ROWID;
CREATE TABLE journal_events (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  saved_at INTEGER NOT NULL,
  changes_json TEXT NOT NULL,
  PRIMARY KEY(session_id, epoch, sequence)
);
CREATE TABLE journal_queue_cards (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  message_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  state TEXT NOT NULL,
  position REAL NOT NULL,
  command_turn_item_id TEXT,
  payload_json TEXT NOT NULL,
  PRIMARY KEY(session_id, epoch, message_id)
);

CREATE TABLE journal_edit_leases (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  caller_key TEXT NOT NULL,
  edit_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  card_revision INTEGER NOT NULL,
  expires_at REAL NOT NULL,
  PRIMARY KEY(session_id, epoch, owner_id, caller_key, edit_id)
) WITHOUT ROWID;


CREATE TABLE journal_maintenance (
  id INTEGER PRIMARY KEY CHECK(id=1),
  compacted_at INTEGER NOT NULL
);
${JOURNAL_DOMAIN_SCHEMA_001_OUTLINE}
${JOURNAL_DOMAIN_SCHEMA_001_INDEXES}
`
