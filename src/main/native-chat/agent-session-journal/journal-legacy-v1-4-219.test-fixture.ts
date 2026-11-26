import Database from '../../sqlite/sync-database'
import { insertJournalRow, publishJournalSessionEpoch } from './durable-rows/journal-row-table'
import { journalSqlRetryRows } from './journal-sql-retry-rows.test-fixture'

/**
 * The shared journal exactly as v1.4.219 created it: `git show v1.4.219:` of
 * journal-database-schema.ts (`createJournalTablesSql`, user_version 3) and queued-message-schema.ts
 * (`ensureQueuedMessagesTable`), copied verbatim.
 */
const V1_4_219_JOURNAL_SQL = `
CREATE TABLE IF NOT EXISTS journal_rows (
  session_id TEXT    NOT NULL,
  epoch      TEXT    NOT NULL,
  seq        INTEGER NOT NULL,
  ts         INTEGER NOT NULL,
  row_json   TEXT    NOT NULL,
  PRIMARY KEY (session_id, epoch, seq)
);
CREATE TABLE IF NOT EXISTS journal_sessions (
  session_id   TEXT PRIMARY KEY,
  workspace_id TEXT    NOT NULL,
  epoch        TEXT    NOT NULL
);
CREATE TABLE IF NOT EXISTS journal_repairs (
  session_id   TEXT PRIMARY KEY,
  epoch        TEXT    NOT NULL,
  content_from INTEGER NOT NULL,
  repaired_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS journal_imports (
  session_id TEXT PRIMARY KEY,
  epoch      TEXT    NOT NULL,
  tip        INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS journal_set_aside (
  session_id TEXT PRIMARY KEY,
  epoch      TEXT    NOT NULL,
  tip        INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS queued_messages (
  session_id      TEXT    NOT NULL,
  message_id      TEXT    NOT NULL,
  position        INTEGER NOT NULL,
  body_json       TEXT    NOT NULL,
  fingerprint     TEXT    NOT NULL,
  created_at      INTEGER NOT NULL,
  host_instance   TEXT    NOT NULL,
  state           TEXT    NOT NULL,
  hold_reason     TEXT,
  returned_reason TEXT,
  returned_rejection TEXT,
  settled_at      INTEGER,
  settled_by_op   TEXT,
  consumed_as     TEXT,
  PRIMARY KEY (session_id, message_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS queued_messages_consumed_as
  ON queued_messages (session_id, consumed_as) WHERE consumed_as IS NOT NULL;
CREATE TABLE IF NOT EXISTS queued_message_pauses (
  session_id  TEXT    PRIMARY KEY,
  reason      TEXT    NOT NULL,
  epoch       TEXT    NOT NULL,
  sequence    INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL
);
`

/** A journal v1.4.219 wrote one chat into; `paused` adds the Stop pause it saved for that chat. */
export function v1_4_219Journal(filename: string, sessionId: string, paused: boolean): void {
  const db = new Database(filename)
  try {
    db.pragma('journal_mode = WAL')
    db.exec(V1_4_219_JOURNAL_SQL)
    db.pragma('user_version = 3')
    publishJournalSessionEpoch(db, { sessionId, workspaceId: 'workspace' }, 'epoch')
    for (const row of journalSqlRetryRows(true)) {
      insertJournalRow(db, sessionId, row)
    }
    if (paused) {
      db.prepare('INSERT INTO queued_message_pauses VALUES(?,?,?,?,?)').run(
        sessionId,
        'stopped',
        'epoch',
        3,
        1000
      )
    }
  } finally {
    db.close()
  }
}
