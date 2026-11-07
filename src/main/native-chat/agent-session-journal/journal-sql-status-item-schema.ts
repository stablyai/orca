export function journalSqlStatusItemSchema(): string {
  return `
CREATE INDEX IF NOT EXISTS journal_proj_items_visible_boundary
  ON journal_proj_items(session_id, epoch, sequence, sequence_index, ordinal)
  WHERE hidden=0 AND (turn_id IS NOT NULL OR context_clear=1);
CREATE INDEX IF NOT EXISTS journal_proj_items_visible_clear
  ON journal_proj_items(session_id, epoch, sequence) WHERE hidden=0 AND context_clear=1;
CREATE INDEX IF NOT EXISTS journal_proj_items_visible_turn
  ON journal_proj_items(session_id, epoch, root, sequence, sequence_index, ordinal)
  WHERE hidden=0 AND turn_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS journal_proj_items_visible_turn_position
  ON journal_proj_items(session_id, epoch, sequence, sequence_index, ordinal)
  WHERE hidden=0 AND turn_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS journal_proj_items_user
  ON journal_proj_items(session_id, epoch, sequence, sequence_index, ordinal)
  WHERE hidden=0 AND root=1 AND message_role='user' AND command_entry=0;
CREATE INDEX IF NOT EXISTS journal_proj_items_unknown_user
  ON journal_proj_items(session_id, epoch, sequence, sequence_index, ordinal)
  WHERE hidden=0 AND root=1 AND message_role='user' AND command_entry=0 AND turn_scope_kind='unknown';
CREATE INDEX IF NOT EXISTS journal_proj_items_prose
  ON journal_proj_items(session_id, epoch, sequence, sequence_index, ordinal)
  WHERE hidden=0 AND root=1 AND message_role='assistant' AND command_entry=0 AND assistant_prose=1;
CREATE INDEX IF NOT EXISTS journal_proj_items_visible_role
  ON journal_proj_items(session_id, epoch, message_role, entry_key) WHERE hidden=0;
CREATE INDEX IF NOT EXISTS journal_proj_items_pending_prompt
  ON journal_proj_items(session_id, epoch, sequence, sequence_index, ordinal)
  WHERE hidden=0 AND kind IN ('approval','question') AND lifecycle_state='pending';
CREATE INDEX IF NOT EXISTS journal_proj_items_tool_action
  ON journal_proj_items(session_id, epoch, sequence, sequence_index, ordinal)
  WHERE hidden=0 AND root=1 AND kind IN ('tool-call','diff');
CREATE INDEX IF NOT EXISTS journal_proj_items_running_tool
  ON journal_proj_items(session_id, epoch, sequence, sequence_index, ordinal)
  WHERE hidden=0 AND root=1 AND kind='tool-call' AND lifecycle_state='running';
CREATE INDEX IF NOT EXISTS journal_proj_items_scoped_status
  ON journal_proj_items(session_id, epoch, turn_item_id, sequence, sequence_index, ordinal)
  WHERE hidden=0 AND kind='status' AND turn_item_id IS NOT NULL;
`
}
