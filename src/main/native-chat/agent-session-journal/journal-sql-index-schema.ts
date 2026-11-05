// Derived indexes are rebuildable; saved journal/outcome formats remain independent.
export function journalSqlIndexSchema(): string {
  return `
CREATE TABLE IF NOT EXISTS journal_proj_places (
  session_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  index_id TEXT NOT NULL,
  id TEXT NOT NULL,
  domain TEXT,
  sequence INTEGER NOT NULL,
  tie INTEGER NOT NULL,
  position REAL NOT NULL,
  head INTEGER NOT NULL,
  command INTEGER NOT NULL,
  waiting INTEGER NOT NULL,
  handoff INTEGER NOT NULL,
  card_json TEXT,
  PRIMARY KEY (session_id, generation, index_id, id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_places_sequence
  ON journal_proj_places(session_id, generation, index_id, sequence, tie);
CREATE INDEX IF NOT EXISTS journal_proj_places_position
  ON journal_proj_places(session_id, generation, index_id, position DESC);
CREATE INDEX IF NOT EXISTS journal_proj_places_live
  ON journal_proj_places(session_id, generation, index_id, domain, sequence)
  WHERE head OR command OR waiting OR handoff;
CREATE INDEX IF NOT EXISTS journal_proj_places_command
  ON journal_proj_places(session_id, generation, index_id, domain, sequence) WHERE command;
CREATE TABLE IF NOT EXISTS journal_proj_domains (
  session_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  index_id TEXT NOT NULL,
  id TEXT NOT NULL,
  introduced INTEGER NOT NULL,
  domain TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  position REAL NOT NULL,
  head INTEGER NOT NULL,
  command INTEGER NOT NULL,
  waiting INTEGER NOT NULL,
  handoff INTEGER NOT NULL,
  card_json TEXT,
  PRIMARY KEY (session_id, generation, index_id, id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_domains_range
  ON journal_proj_domains(session_id, generation, index_id, introduced, domain, sequence);
CREATE TABLE IF NOT EXISTS journal_proj_release_state (
  session_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  index_id TEXT NOT NULL,
  floor REAL,
  pause_gen INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, generation, index_id)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS journal_proj_releases (
  session_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  index_id TEXT NOT NULL,
  id TEXT NOT NULL,
  introduced INTEGER NOT NULL,
  position REAL NOT NULL,
  pause_gen INTEGER NOT NULL,
  PRIMARY KEY (session_id, generation, index_id, id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_releases_position
  ON journal_proj_releases(session_id, generation, index_id, position DESC);
CREATE INDEX IF NOT EXISTS journal_proj_releases_pause
  ON journal_proj_releases(session_id, generation, index_id, pause_gen, position DESC);
CREATE TABLE IF NOT EXISTS journal_proj_turn_sources (
  session_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  sequence_index INTEGER NOT NULL,
  ordinary INTEGER NOT NULL,
  relevant INTEGER NOT NULL,
  source_json TEXT NOT NULL,
  PRIMARY KEY (session_id, generation, id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_turn_sources_latest
  ON journal_proj_turn_sources(session_id, generation, sequence DESC, sequence_index DESC);
CREATE INDEX IF NOT EXISTS journal_proj_turn_sources_anchor
  ON journal_proj_turn_sources(session_id, generation, sequence DESC, sequence_index DESC)
  WHERE ordinary;
CREATE INDEX IF NOT EXISTS journal_proj_turn_sources_winner
  ON journal_proj_turn_sources(session_id, generation, sequence DESC, sequence_index DESC)
  WHERE relevant;
CREATE TABLE IF NOT EXISTS journal_proj_candidates (
  session_id TEXT NOT NULL,
  generation TEXT NOT NULL,
  index_id TEXT NOT NULL,
  id TEXT NOT NULL,
  position REAL NOT NULL,
  is_mail INTEGER NOT NULL,
  card_json TEXT NOT NULL,
  PRIMARY KEY (session_id, generation, index_id, id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS journal_proj_candidates_position
  ON journal_proj_candidates(session_id, generation, index_id, position);
CREATE INDEX IF NOT EXISTS journal_proj_candidates_mail
  ON journal_proj_candidates(session_id, generation, index_id) WHERE is_mail;
`
}
