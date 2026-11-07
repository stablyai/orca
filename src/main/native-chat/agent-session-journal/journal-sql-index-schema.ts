// Derived indexes are rebuildable; saved journal/outcome formats remain independent.
export function journalSqlIndexSchema(): string {
  return `
CREATE TABLE IF NOT EXISTS journal_proj_places (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  index_id TEXT NOT NULL,
  id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  tie INTEGER NOT NULL,
  position REAL NOT NULL,
  PRIMARY KEY (session_id, epoch, index_id, id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_places_sequence
  ON journal_proj_places(session_id, epoch, index_id, sequence, tie);
CREATE INDEX IF NOT EXISTS journal_proj_places_position
  ON journal_proj_places(session_id, epoch, index_id, position DESC);
CREATE TABLE IF NOT EXISTS journal_proj_turn_sources (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  sequence_index INTEGER NOT NULL,
  ordinary INTEGER NOT NULL,
  relevant INTEGER NOT NULL,
  source_json TEXT NOT NULL,
  PRIMARY KEY (session_id, epoch, id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_turn_sources_latest
  ON journal_proj_turn_sources(session_id, epoch, sequence DESC, sequence_index DESC);
CREATE INDEX IF NOT EXISTS journal_proj_turn_sources_anchor
  ON journal_proj_turn_sources(session_id, epoch, sequence DESC, sequence_index DESC)
  WHERE ordinary;
CREATE INDEX IF NOT EXISTS journal_proj_turn_sources_winner
  ON journal_proj_turn_sources(session_id, epoch, sequence DESC, sequence_index DESC)
  WHERE relevant;
`
}
