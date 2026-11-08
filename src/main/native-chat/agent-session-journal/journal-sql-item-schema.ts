export const JOURNAL_SQL_NAMED_TURN_INDEX = `CREATE INDEX IF NOT EXISTS journal_proj_items_named_turn
  ON journal_proj_items(session_id, epoch, turn_id, sequence DESC, sequence_index DESC, ordinal DESC)
  WHERE turn_id IS NOT NULL AND hidden=0;`

export function journalSqlItemSchema(): string {
  return `
CREATE TABLE IF NOT EXISTS journal_proj_item_versions (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  entry_key TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  outcome_generation INTEGER,
  outcome_seq INTEGER,
  inline_json TEXT,
  PRIMARY KEY (session_id, epoch, entry_key, incarnation),
  CHECK ((outcome_generation IS NOT NULL AND outcome_seq IS NOT NULL AND inline_json IS NULL)
    OR (outcome_generation IS NULL AND outcome_seq IS NULL AND inline_json IS NOT NULL))
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS journal_proj_items (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  entry_key TEXT NOT NULL,
  incarnation INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  sequence_index INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  kind TEXT NOT NULL,
  turn_id TEXT,
  turn_item_id TEXT,
  opener_item_id TEXT,
  root INTEGER NOT NULL,
  subagent_id TEXT,
  context_clear INTEGER NOT NULL,
  hidden INTEGER NOT NULL DEFAULT 0,
  byte_size INTEGER NOT NULL,
  live_work INTEGER NOT NULL DEFAULT 0,
  subagent_row INTEGER NOT NULL DEFAULT 0,
  subagent_group_key TEXT,
  subagent_names TEXT,
  message_role TEXT,
  command_entry INTEGER NOT NULL DEFAULT 0,
  lifecycle_state TEXT,
  assistant_prose INTEGER NOT NULL DEFAULT 0,
  turn_scope_kind TEXT,
  producer_agent_id TEXT,
  producer_parent_ref TEXT,
  producer_attempt INTEGER,
  PRIMARY KEY (session_id, epoch, entry_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_items_position
  ON journal_proj_items(session_id, epoch, sequence, sequence_index);
CREATE INDEX IF NOT EXISTS journal_proj_items_root
  ON journal_proj_items(session_id, epoch, sequence, sequence_index) WHERE root=1;
CREATE INDEX IF NOT EXISTS journal_proj_items_subagent
  ON journal_proj_items(session_id, epoch, subagent_id, sequence, sequence_index);
CREATE INDEX IF NOT EXISTS journal_proj_items_turn
  ON journal_proj_items(session_id, epoch, sequence DESC, ordinal DESC)
  WHERE turn_id IS NOT NULL OR context_clear=1;
${JOURNAL_SQL_NAMED_TURN_INDEX}
CREATE INDEX IF NOT EXISTS journal_proj_items_clear
  ON journal_proj_items(session_id, epoch, sequence DESC) WHERE context_clear=1;
CREATE INDEX IF NOT EXISTS journal_proj_items_live_work
  ON journal_proj_items(session_id, epoch, ordinal) WHERE live_work=1;
CREATE INDEX IF NOT EXISTS journal_proj_items_subagent_group
  ON journal_proj_items(session_id, epoch, subagent_group_key, sequence, sequence_index)
  WHERE subagent_group_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS journal_proj_items_opener
  ON journal_proj_items(session_id, epoch, opener_item_id) WHERE opener_item_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS journal_proj_items_kind
  ON journal_proj_items(session_id, epoch, kind, ordinal);
CREATE INDEX IF NOT EXISTS journal_proj_items_unsettled
  ON journal_proj_items(session_id, epoch, ordinal)
  WHERE lifecycle_state IN ('running','pending') OR live_work=1;
CREATE INDEX IF NOT EXISTS journal_proj_items_parent_alias
  ON journal_proj_items(session_id, epoch, producer_parent_ref, ordinal DESC)
  WHERE producer_parent_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS journal_proj_items_agent_attempt
  ON journal_proj_items(session_id, epoch, producer_agent_id, producer_attempt DESC)
  WHERE producer_agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS journal_proj_items_roster
  ON journal_proj_items(session_id, epoch, ordinal) WHERE subagent_names IS NOT NULL;
CREATE INDEX IF NOT EXISTS journal_proj_items_turn_scope
  ON journal_proj_items(session_id, epoch, turn_item_id, kind) WHERE turn_item_id IS NOT NULL;
`
}
