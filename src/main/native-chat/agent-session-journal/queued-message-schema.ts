// The draft table's shape, created and healed at every writable open.

import type Database from '../../sqlite/sync-database'

/** Columns a later build added, so an older draft table can gain them in place. */
const NULLABLE_COLUMNS: readonly (readonly [name: string, type: string])[] = [
  ['hold_reason', 'TEXT'],
  ['returned_reason', 'TEXT'],
  ['returned_rejection', 'TEXT'],
  ['settled_at', 'INTEGER'],
  ['settled_by_op', 'TEXT'],
  ['consumed_as', 'TEXT']
]

/**
 * Created idempotently at EVERY writable open, never lazily at first insert, so
 * no reader hits "no such table". Deliberately no `user_version` bump: an old
 * build sees stored == supported and stays writable, ignoring the table; a bump
 * would latch every opened db read-only after a downgrade (`journal-database.ts`).
 * For the same reason a missing column is added here rather than versioned:
 * `CREATE TABLE IF NOT EXISTS` never reshapes a table an earlier build created.
 */
export function ensureQueuedMessagesTable(db: Database.Database): void {
  db.exec(`
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
`)
  const names = new Set(
    db
      .prepare('PRAGMA table_info(queued_messages)')
      .all()
      .flatMap((column) =>
        typeof column === 'object' &&
        column !== null &&
        'name' in column &&
        typeof column.name === 'string'
          ? [column.name]
          : []
      )
  )
  for (const [name, type] of NULLABLE_COLUMNS) {
    if (!names.has(name)) {
      db.exec(`ALTER TABLE queued_messages ADD COLUMN ${name} ${type}`)
    }
  }
  db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS queued_messages_consumed_as
  ON queued_messages (session_id, consumed_as) WHERE consumed_as IS NOT NULL;
CREATE TABLE IF NOT EXISTS queued_message_pauses (
  session_id  TEXT    PRIMARY KEY,
  reason      TEXT    NOT NULL,
  epoch       TEXT    NOT NULL,
  sequence    INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL
);
`)
}
