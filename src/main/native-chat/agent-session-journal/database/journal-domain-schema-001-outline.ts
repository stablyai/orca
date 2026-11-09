export const JOURNAL_DOMAIN_SCHEMA_001_OUTLINE = `
CREATE TABLE journal_outline_members (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  item_id TEXT NOT NULL,
  source_revision INTEGER NOT NULL,
  sequence INTEGER NOT NULL,
  sequence_index INTEGER NOT NULL,
  ordinal INTEGER NOT NULL,
  structure_json TEXT NOT NULL,
  turn_key TEXT,
  reply TEXT,
  entry_json TEXT,
  short_json TEXT,
  empty_json TEXT,
  entry_bytes INTEGER NOT NULL,
  short_bytes INTEGER NOT NULL,
  empty_bytes INTEGER NOT NULL,
  PRIMARY KEY(session_id,epoch,item_id)
) WITHOUT ROWID;
CREATE INDEX journal_outline_entries ON journal_outline_members(session_id,epoch,sequence,sequence_index,ordinal)
  WHERE entry_json IS NOT NULL;
CREATE INDEX journal_outline_reply_candidates ON journal_outline_members(session_id,epoch,turn_key,sequence DESC,sequence_index DESC,ordinal DESC)
  WHERE reply IS NOT NULL;
CREATE TABLE journal_outline_replies (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  turn_key TEXT NOT NULL,
  reply TEXT NOT NULL,
  reply_bytes INTEGER NOT NULL,
  PRIMARY KEY(session_id,epoch,turn_key)
) WITHOUT ROWID;
`
