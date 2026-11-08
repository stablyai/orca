export const JOURNAL_DOMAIN_SCHEMA_001 = `
CREATE TABLE journal_sessions (
  session_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  epoch TEXT NOT NULL
);
CREATE TABLE agent_session_records (
  session_id TEXT PRIMARY KEY,
  record_json TEXT NOT NULL
);
CREATE TABLE agent_session_operations (
  operation_key TEXT PRIMARY KEY,
  row_json TEXT NOT NULL
);
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
CREATE INDEX idx_agent_session_clear_successor ON agent_session_records(
  CASE WHEN json_valid(record_json) THEN json_extract(record_json, '$.conversationCommand.replacementSessionId') END);
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
CREATE INDEX agent_session_command_receipts_session ON agent_session_command_receipts(session_id);
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
  epoch TEXT NOT NULL,
  last_sequence INTEGER NOT NULL,
  retained_sequence INTEGER NOT NULL DEFAULT 0,
  highest_fence INTEGER NOT NULL,
  context_boundary INTEGER NOT NULL DEFAULT 0,
  last_activity_at INTEGER NOT NULL DEFAULT 0,
  derived_turn_item_id TEXT,
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
  payload_json TEXT NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  root INTEGER NOT NULL DEFAULT 1,
  subagent_row INTEGER NOT NULL DEFAULT 0,
  subagent_group_key TEXT,
  turn_marker INTEGER NOT NULL DEFAULT 0,
  wire_bytes INTEGER,
  turn_item_id TEXT,
  original_stop_note_json TEXT,
  queue_command_turn INTEGER NOT NULL DEFAULT 0,
  queue_failed_outcome INTEGER NOT NULL DEFAULT 0,
  queue_failed_at INTEGER NOT NULL DEFAULT 0,
  queue_failure_witnessed_through INTEGER NOT NULL DEFAULT 0,
  queue_failure_report_turn_item_id TEXT,
  placement_json TEXT,
  kind TEXT,
  message_role TEXT,
  turn_id TEXT,
  opener_item_id TEXT,
  context_clear INTEGER NOT NULL DEFAULT 0,
  goal_transition INTEGER NOT NULL DEFAULT 0,
  producer_agent_id TEXT,
  producer_parent_ref TEXT,
  producer_attempt INTEGER,
  prompt INTEGER NOT NULL DEFAULT 0,
  signed_out INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(session_id, epoch, item_id)
);
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
CREATE INDEX journal_item_subagent_names_item ON journal_item_subagent_names(session_id, epoch, item_id);
CREATE INDEX journal_item_subagent_names_visible ON journal_item_subagent_names(
  session_id, epoch, subagent_id, sequence, sequence_index, ordinal) WHERE hidden=0;
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
CREATE INDEX journal_item_aliases_target ON journal_item_aliases(session_id, epoch, item_id);
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
  fingerprint TEXT NOT NULL,
  dispatch_state TEXT NOT NULL,
  dispatch_fence INTEGER NOT NULL DEFAULT 0,
  signed_out INTEGER NOT NULL DEFAULT 0 CHECK(signed_out IN (0,1)),
  candidate INTEGER NOT NULL DEFAULT 0,
  admitted_personal INTEGER NOT NULL DEFAULT 0 CHECK(admitted_personal IN (0,1)),
  echo_observed INTEGER NOT NULL DEFAULT 0 CHECK(echo_observed IN (0,1)),
  admission_body_json TEXT,
  admission_provider_handle_json TEXT,
  admission_fence INTEGER NOT NULL DEFAULT 0,
  admission_scope_json TEXT,
  admission_family_id TEXT,
  admission_origin TEXT,
  admission_source_kind TEXT,
  admission_options_json TEXT,
  handover_sequence INTEGER,
  handover_at INTEGER,
  handover_fence INTEGER,
  handover_scope_json TEXT,
  handover_place_sequence INTEGER,
  handover_place_at INTEGER,
  handover_place_scope_json TEXT,
  carries_json TEXT,
  rejection_sequence INTEGER,
  rejection_at INTEGER,
  rejection_fence INTEGER,
  rejection_reason TEXT,
  rejection_fact_json TEXT,
  rejection_recovered INTEGER,
  rejection_kept_message_id TEXT,
  rejection_answered_turn_json TEXT,
  presentation_member INTEGER NOT NULL DEFAULT 0 CHECK(presentation_member IN (0,1)),
  normalized_handoff INTEGER NOT NULL DEFAULT 0 CHECK(normalized_handoff IN (0,1)),
  payload_json TEXT NOT NULL,
  PRIMARY KEY(session_id, epoch, message_id, attempt_sequence, attempt_index)
);
CREATE UNIQUE INDEX journal_submission_head ON journal_submission_attempts(session_id, epoch, message_id) WHERE current=1;
CREATE UNIQUE INDEX journal_submission_item ON journal_submission_attempts(session_id, epoch, item_id) WHERE current=1;
CREATE INDEX journal_submission_echo ON journal_submission_attempts(session_id, epoch, fingerprint, submitted_at, ordinal) WHERE current=1;
CREATE INDEX journal_submission_person_acceptance ON journal_submission_attempts(session_id, epoch, accepted_sequence DESC) WHERE dispatch_state='accepted' AND admitted_personal=1;
CREATE INDEX journal_submission_family ON journal_submission_attempts(session_id,epoch,admission_family_id,attempt_sequence,attempt_index,ordinal) WHERE current=1;
CREATE INDEX journal_submission_ordinal ON journal_submission_attempts(session_id,epoch,ordinal);
CREATE INDEX journal_submission_acceptance ON journal_submission_attempts(session_id, epoch, accepted_sequence DESC) WHERE dispatch_state='accepted';
CREATE TABLE journal_send_receipts (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  message_id TEXT NOT NULL,
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
CREATE INDEX journal_queue_order ON journal_queue_cards(session_id, epoch, position, message_id)
  WHERE state IN ('waiting','returned');
CREATE INDEX journal_queue_last_position ON journal_queue_cards(session_id, epoch, position);
CREATE INDEX journal_queue_returned_commands ON journal_queue_cards(session_id, epoch, command_turn_item_id)
  WHERE state='returned';

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
CREATE INDEX journal_edit_leases_message ON journal_edit_leases(session_id, epoch, message_id);
CREATE INDEX journal_edit_leases_deadline ON journal_edit_leases(session_id, epoch, expires_at);
CREATE INDEX journal_items_root_position ON journal_items(session_id, epoch, sequence, sequence_index, ordinal)
  WHERE hidden=0 AND root=1;
CREATE INDEX journal_items_queue_eligible_turn ON journal_items(session_id, epoch, sequence, sequence_index, ordinal)
  WHERE hidden=0 AND turn_marker=1 AND (queue_command_turn=0 OR queue_failed_outcome=0 OR queue_failed_at>0);
CREATE INDEX journal_items_turn_marker ON journal_items(session_id, epoch, sequence, sequence_index, ordinal)
  WHERE hidden=0 AND turn_marker=1;
CREATE INDEX journal_items_visible_position ON journal_items(session_id, epoch, sequence, sequence_index, ordinal)
  WHERE hidden=0;
CREATE INDEX journal_items_queue_failure_report ON journal_items(session_id, epoch, queue_failure_report_turn_item_id)
  WHERE hidden=0 AND queue_failure_report_turn_item_id IS NOT NULL;
CREATE INDEX journal_items_stop_turn ON journal_items(session_id, epoch, turn_item_id)
  WHERE hidden=0 AND turn_item_id IS NOT NULL;
CREATE INDEX journal_events_saved_at ON journal_events(saved_at,session_id,epoch,sequence);

CREATE INDEX journal_items_kind ON journal_items(session_id, epoch, kind, ordinal) WHERE hidden=0;
CREATE INDEX journal_items_user_message ON journal_items(session_id, epoch, ordinal)
  WHERE hidden=0 AND kind='message' AND message_role='user';
CREATE INDEX journal_items_named_turn ON journal_items(session_id, epoch, turn_id, sequence, sequence_index, ordinal)
  WHERE hidden=0 AND turn_id IS NOT NULL;
CREATE INDEX journal_items_opener ON journal_items(session_id, epoch, opener_item_id, ordinal)
  WHERE hidden=0 AND opener_item_id IS NOT NULL;
CREATE INDEX journal_items_context_clear ON journal_items(session_id, epoch, sequence)
  WHERE hidden=0 AND context_clear=1;
CREATE INDEX journal_items_goal_transition ON journal_items(session_id, epoch, sequence, ordinal)
  WHERE hidden=0 AND goal_transition=1;
CREATE INDEX journal_items_producer_parent ON journal_items(session_id, epoch, producer_parent_ref, ordinal, producer_agent_id)
  WHERE hidden=0 AND producer_parent_ref IS NOT NULL;
CREATE INDEX journal_items_producer_attempt ON journal_items(session_id, epoch, producer_agent_id, producer_attempt)
  WHERE hidden=0 AND producer_agent_id IS NOT NULL;
CREATE INDEX journal_items_prompt ON journal_items(session_id, epoch, sequence, ordinal)
  WHERE hidden=0 AND prompt=1;
CREATE INDEX journal_items_signed_out ON journal_items(session_id, epoch, COALESCE(execution_owner,owner_fence))
  WHERE hidden=0 AND root=1 AND signed_out=1;
CREATE INDEX journal_submission_accepted_position ON journal_submission_attempts(session_id, epoch, accepted_sequence, ordinal)
  WHERE current=1 AND accepted_sequence IS NOT NULL;
CREATE INDEX journal_submission_signed_out ON journal_submission_attempts(session_id,epoch,dispatch_fence)
  WHERE current=1 AND signed_out=1;
CREATE INDEX journal_submission_order ON journal_submission_attempts(session_id, epoch, submitted_at, ordinal, message_id)
  WHERE current=1;

CREATE TABLE journal_maintenance (
  id INTEGER PRIMARY KEY CHECK(id=1),
  compacted_at INTEGER NOT NULL
);
`
