export const JOURNAL_DOMAIN_SCHEMA_001_INDEXES = `
CREATE INDEX journal_submission_sending ON journal_submission_attempts(session_id,epoch,ordinal,message_id)
  WHERE current=1 AND dispatch_state='pending';
CREATE INDEX idx_agent_session_clear_successor ON agent_session_records(
  CASE WHEN json_valid(record_json) THEN json_extract(record_json, '$.conversationCommand.replacementSessionId') END);
CREATE INDEX agent_session_command_receipts_session ON agent_session_command_receipts(session_id);
CREATE INDEX journal_chat_ready ON journal_chat_state(session_id) WHERE epoch IS NOT NULL;
CREATE INDEX journal_items_ordinal ON journal_items(session_id,epoch,ordinal);
CREATE INDEX journal_items_unsettled ON journal_items(session_id,epoch,ordinal,item_id)
  WHERE hidden=0 AND (lifecycle_state IN ('running','pending') OR live_work=1);
CREATE INDEX journal_items_context_window ON journal_items(session_id,epoch) WHERE hidden=0 AND context_window=1;
CREATE INDEX journal_items_unverified_end ON journal_items(session_id,epoch,ordinal,item_id) WHERE hidden=0 AND unverified_end=1;
CREATE INDEX journal_items_unverifiable_turn ON journal_items(session_id,epoch,ordinal,item_id) WHERE hidden=0 AND kind IN ('turn','status') AND lifecycle_state='unverifiable';
CREATE INDEX journal_items_interrupted_root ON journal_items(session_id,epoch,turn_completed_at,sequence,sequence_index,ordinal,item_id)
  WHERE hidden=0 AND root=1 AND kind IN ('turn','status') AND lifecycle_state='interrupted' AND turn_completed_at IS NOT NULL;
CREATE INDEX journal_item_subagent_names_item ON journal_item_subagent_names(session_id, epoch, item_id);
CREATE INDEX journal_item_subagent_names_visible ON journal_item_subagent_names(
  session_id, epoch, subagent_id, sequence, sequence_index, ordinal) WHERE hidden=0;
CREATE INDEX journal_item_aliases_target ON journal_item_aliases(session_id, epoch, item_id);
CREATE INDEX journal_submission_echo ON journal_submission_attempts(session_id, epoch, fingerprint, submitted_at, ordinal) WHERE current=1;
CREATE INDEX journal_submission_person_acceptance ON journal_submission_attempts(session_id, epoch, accepted_sequence DESC) WHERE dispatch_state='accepted' AND admitted_personal=1;
CREATE INDEX journal_submission_family ON journal_submission_attempts(session_id,epoch,admission_family_id,attempt_sequence,attempt_index,ordinal) WHERE current=1;
CREATE INDEX journal_submission_ordinal ON journal_submission_attempts(session_id,epoch,ordinal);
CREATE INDEX journal_submission_recovery ON journal_submission_attempts(session_id,epoch,ordinal,message_id)
  WHERE current=1 AND (dispatch_state='pending' OR (dispatch_state='unknown' AND recovered=0));
CREATE INDEX journal_submission_acceptance ON journal_submission_attempts(session_id, epoch, accepted_sequence DESC) WHERE dispatch_state='accepted';
CREATE INDEX journal_submission_candidates ON journal_submission_attempts(session_id,epoch,ordinal,message_id) WHERE current=1 AND candidate=1;
CREATE INDEX journal_submission_unsettled ON journal_submission_attempts(session_id,epoch,ordinal,message_id) WHERE current=1 AND dispatch_state IN ('pending','unknown');
CREATE INDEX journal_submission_status_accepted ON journal_submission_attempts(session_id,epoch,submitted_at,ordinal,message_id) WHERE current=1 AND dispatch_state='accepted';
CREATE INDEX journal_submission_status_failed ON journal_submission_attempts(session_id,epoch,accepted_sequence,ordinal,message_id) WHERE current=1 AND request_failure=1;
CREATE INDEX journal_submission_non_refused ON journal_submission_attempts(session_id,epoch,accepted_sequence,ordinal,message_id) WHERE current=1 AND dispatch_state<>'rejected' AND accepted_sequence IS NOT NULL;
CREATE INDEX journal_submission_steer ON journal_submission_attempts(session_id,epoch,steer_turn_item_id,accepted_sequence,ordinal) WHERE current=1 AND steer_turn_item_id IS NOT NULL;
CREATE INDEX journal_submission_submitted ON journal_submission_attempts(session_id,epoch,submitted_sequence) WHERE current=1 AND submitted_sequence IS NOT NULL;
CREATE INDEX journal_submission_stopped ON journal_submission_attempts(session_id,epoch,ordinal,message_id) WHERE current=1 AND stopped_history=1;
CREATE INDEX journal_submission_carriers ON journal_submission_attempts(session_id,epoch,ordinal,message_id) WHERE current=1 AND covers_stopped_history=1;
CREATE INDEX journal_send_receipt_sequence ON journal_send_receipts(session_id,epoch,cursor_sequence,message_id);
CREATE INDEX journal_queue_order ON journal_queue_cards(session_id, epoch, position, message_id)
  WHERE state IN ('waiting','returned');
CREATE INDEX journal_queue_last_position ON journal_queue_cards(session_id, epoch, position);
CREATE INDEX journal_queue_source_metadata ON journal_queue_cards(session_id,epoch,message_id,
  CASE WHEN json_valid(payload_json) THEN octet_length(json_extract(payload_json,'$.body')) END,
  CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.queuedAt.sequence') END);
CREATE INDEX journal_queue_returned_commands ON journal_queue_cards(session_id, epoch, command_turn_item_id)
  WHERE state='returned';
CREATE INDEX journal_edit_leases_message ON journal_edit_leases(session_id, epoch, message_id);
CREATE INDEX journal_edit_leases_deadline ON journal_edit_leases(session_id, epoch, expires_at);
CREATE INDEX journal_items_root_position ON journal_items(session_id, epoch, sequence, sequence_index, ordinal)
  WHERE hidden=0 AND root=1;
CREATE INDEX journal_items_queue_eligible_turn ON journal_items(session_id, epoch, sequence, sequence_index, ordinal)
  WHERE hidden=0 AND turn_marker=1 AND (queue_command_turn=0 OR queue_failed_outcome=0 OR queue_failed_at>0);
CREATE INDEX journal_items_turn_marker ON journal_items(session_id, epoch, sequence, sequence_index, ordinal)
  WHERE hidden=0 AND turn_marker=1;
CREATE INDEX journal_items_raw_turn_marker ON journal_items(session_id,epoch,sequence,ordinal)
  WHERE turn_marker=1;
CREATE INDEX journal_items_visible_position ON journal_items(session_id, epoch, sequence, sequence_index, ordinal)
  WHERE hidden=0;
CREATE INDEX journal_items_queue_failure_report ON journal_items(session_id, epoch, queue_failure_report_turn_item_id)
  WHERE hidden=0 AND queue_failure_report_turn_item_id IS NOT NULL;
CREATE INDEX journal_items_stop_turn ON journal_items(session_id, epoch, turn_item_id)
  WHERE hidden=0 AND turn_item_id IS NOT NULL;
CREATE INDEX journal_items_original_stop_note ON journal_items(session_id,epoch,ordinal)
  WHERE hidden=0 AND original_stop_note_json IS NOT NULL;
CREATE INDEX journal_items_teardown_turn ON journal_items(session_id,epoch,sequence,sequence_index,ordinal)
  WHERE hidden=0 AND root=1 AND turn_id IS NOT NULL AND queue_command_turn=0;
CREATE INDEX journal_events_saved_at ON journal_events(saved_at,session_id,epoch,sequence);
CREATE INDEX journal_items_kind ON journal_items(session_id, epoch, kind, ordinal) WHERE hidden=0;
CREATE INDEX journal_items_user_message ON journal_items(session_id, epoch, ordinal)
  WHERE hidden=0 AND kind='message' AND message_role='user';
CREATE INDEX journal_items_named_turn ON journal_items(session_id, epoch, turn_id, sequence, sequence_index, ordinal)
  WHERE hidden=0 AND turn_id IS NOT NULL;
CREATE INDEX journal_items_provider_turn ON journal_items(session_id,epoch,provider_turn_id,sequence,sequence_index,ordinal)
  WHERE provider_turn_id IS NOT NULL;
CREATE INDEX journal_items_codex_turn ON journal_items(session_id,epoch,codex_thread_id,codex_turn_id,sequence,sequence_index,ordinal)
  WHERE hidden=0 AND codex_turn_id IS NOT NULL;
CREATE INDEX journal_items_visible_provider_key ON journal_items(session_id,epoch,legacy_provider_item_key)
  WHERE hidden=0 AND legacy_provider_item_key IS NOT NULL;
CREATE INDEX journal_submission_codex_turn ON journal_submission_attempts(session_id,epoch,codex_thread_id,codex_turn_id,item_id)
  WHERE current=1 AND dispatch_state='accepted';
CREATE INDEX journal_items_opener ON journal_items(session_id, epoch, opener_item_id, ordinal)
  WHERE hidden=0 AND opener_item_id IS NOT NULL;
CREATE INDEX journal_items_context_clear ON journal_items(session_id, epoch, sequence)
  WHERE hidden=0 AND context_clear=1;
CREATE INDEX journal_items_raw_context_clear ON journal_items(session_id,epoch,sequence)
  WHERE context_clear=1;
CREATE INDEX journal_items_goal_transition ON journal_items(session_id, epoch, sequence, ordinal)
  WHERE hidden=0 AND goal_transition=1;
CREATE INDEX journal_items_producer_parent ON journal_items(session_id, epoch, producer_parent_ref, ordinal, producer_agent_id)
  WHERE hidden=0 AND producer_parent_ref IS NOT NULL;
CREATE INDEX journal_items_producer_attempt ON journal_items(session_id, epoch, producer_agent_id, producer_attempt)
  WHERE hidden=0 AND producer_agent_id IS NOT NULL;
CREATE INDEX journal_items_status_turn ON journal_items(session_id,epoch,sequence,sequence_index,ordinal) WHERE hidden=0 AND turn_id IS NOT NULL;
CREATE INDEX journal_items_status_prompt ON journal_items(session_id,epoch,sequence,sequence_index,ordinal) WHERE hidden=0 AND prompt=1;
CREATE INDEX journal_items_status_prose ON journal_items(session_id,epoch,sequence,sequence_index,ordinal) WHERE hidden=0 AND root=1 AND message_role='assistant' AND command_entry=0 AND assistant_prose=1;
CREATE INDEX journal_items_status_pending ON journal_items(session_id,epoch,sequence,sequence_index,ordinal) WHERE hidden=0 AND kind IN ('approval','question') AND lifecycle_state='pending';
CREATE INDEX journal_items_status_tool ON journal_items(session_id,epoch,sequence,sequence_index,ordinal) WHERE hidden=0 AND root=1 AND kind IN ('tool-call','diff');
CREATE INDEX journal_items_status_assistant ON journal_items(session_id,epoch) WHERE hidden=0 AND message_role='assistant';
CREATE INDEX journal_items_signed_out ON journal_items(session_id, epoch, COALESCE(execution_owner,owner_fence))
  WHERE hidden=0 AND root=1 AND signed_out=1;
CREATE INDEX journal_submission_accepted_position ON journal_submission_attempts(session_id, epoch, accepted_sequence, ordinal)
  WHERE current=1 AND accepted_sequence IS NOT NULL;
CREATE INDEX journal_submission_signed_out ON journal_submission_attempts(session_id,epoch,dispatch_fence)
  WHERE current=1 AND signed_out=1;
CREATE INDEX journal_submission_latest_fence ON journal_submission_attempts(session_id,epoch,dispatch_fence,submitted_at,ordinal) WHERE current=1;
CREATE INDEX journal_submission_order ON journal_submission_attempts(session_id, epoch, submitted_at, ordinal, message_id)
  WHERE current=1;
`
