import type Database from '../../sqlite/sync-database'

/** This ledger deliberately leaves the profile's global user_version unchanged. */
export function migrateJournalDomainSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS journal_domain_migrations (
    version INTEGER PRIMARY KEY
  )`)
  const version = Number(
    db.prepare('SELECT MAX(version) AS version FROM journal_domain_migrations').get()?.version ?? 0
  )
  if (version === 1) {
    return
  }
  if (version > 1) {
    throw new Error('journal domain schema is newer than this writer')
  }
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec(`
CREATE TABLE journal_chat_state (
  session_id TEXT PRIMARY KEY,
  epoch TEXT NOT NULL,
  last_sequence INTEGER NOT NULL,
  retained_sequence INTEGER NOT NULL DEFAULT 0,
  highest_fence INTEGER NOT NULL,
  context_boundary INTEGER NOT NULL DEFAULT 0,
  last_activity_at INTEGER NOT NULL DEFAULT 0
);
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
  PRIMARY KEY(session_id, epoch, item_id)
) WITHOUT ROWID;
CREATE INDEX journal_items_position ON journal_items(session_id, epoch, sequence, sequence_index, ordinal);
CREATE TABLE journal_item_tombstones (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  item_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY(session_id, epoch, item_id)
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
  candidate INTEGER NOT NULL DEFAULT 0,
  source_card_sequence INTEGER,
  source_card_index INTEGER,
  payload_json TEXT NOT NULL,
  PRIMARY KEY(session_id, epoch, message_id, attempt_sequence, attempt_index)
) WITHOUT ROWID;
CREATE UNIQUE INDEX journal_submission_head ON journal_submission_attempts(session_id, epoch, message_id) WHERE current=1;
CREATE UNIQUE INDEX journal_submission_item ON journal_submission_attempts(session_id, epoch, item_id) WHERE current=1;
CREATE INDEX journal_submission_echo ON journal_submission_attempts(session_id, epoch, fingerprint, submitted_at, ordinal) WHERE current=1;
CREATE INDEX journal_submission_acceptance ON journal_submission_attempts(session_id, epoch, accepted_sequence DESC) WHERE dispatch_state='accepted';
CREATE TABLE journal_send_receipts (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  message_id TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY(session_id, epoch, message_id)
) WITHOUT ROWID;
CREATE TABLE journal_card_versions (
  session_id TEXT NOT NULL,
  epoch TEXT NOT NULL,
  message_id TEXT NOT NULL,
  version_sequence INTEGER NOT NULL,
  version_index INTEGER NOT NULL,
  current INTEGER NOT NULL CHECK(current IN (0,1)),
  state TEXT NOT NULL,
  command_turn_item_id TEXT,
  payload_json TEXT NOT NULL,
  PRIMARY KEY(session_id, epoch, message_id, version_sequence, version_index)
) WITHOUT ROWID;
CREATE UNIQUE INDEX journal_card_head ON journal_card_versions(session_id, epoch, message_id) WHERE current=1;
CREATE INDEX journal_returned_commands ON journal_card_versions(session_id, epoch, command_turn_item_id) WHERE current=1 AND state='returned';
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
) WITHOUT ROWID;
INSERT INTO journal_domain_migrations(version) VALUES (1);
`)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}
