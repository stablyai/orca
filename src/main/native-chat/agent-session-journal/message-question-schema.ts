import type Database from '../../sqlite/sync-database'

/** Source linkage and occurrence creation share the host transaction, including terminal observers. */
export function ensureMessageQuestionTables(db: Database.Database): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS message_question_sources (
  source_id TEXT PRIMARY KEY,
  owner_session_id TEXT REFERENCES agent_session_records(session_id) ON DELETE CASCADE,
  identity_json TEXT NOT NULL,
  state_json TEXT
);
CREATE INDEX IF NOT EXISTS message_question_source_owner ON message_question_sources(owner_session_id);
CREATE TABLE IF NOT EXISTS message_question_occurrences (
  occurrence_id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES message_question_sources(source_id) ON DELETE CASCADE,
  record_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS message_question_occurrence_source ON message_question_occurrences(source_id);
`)
}
