import type { OrchestrationDb } from '../orchestration-db'
import { numberColumn, textColumn, textColumnValues } from '../../../../sqlite/sqlite-row-columns'

const TYPE_CHECK_TAIL = /('heartbeat')(\s*\)\s*\))/
const TABLE_NAME = /^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:"messages"|messages)(?=\s*\()/i

/** Lets messages store `notice`. SQLite cannot alter a CHECK, so the table is rebuilt once, as v9 did. */
export function migrateV47(this: OrchestrationDb): void {
  // Gated on the CHECK, not the version: another build may already have moved this database to v47.
  if (this.messagesTypeCheckAllowsNotice()) {
    return
  }
  // The live definition, not a fixed one: columns added on open (or by ALTER) and their data must survive.
  const table = this.db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'messages'")
    .get()
  const tableSql = table ? textColumn(table, 'sql') : null
  if (!tableSql || !TYPE_CHECK_TAIL.test(tableSql) || !TABLE_NAME.test(tableSql)) {
    throw new Error('messages type CHECK has an unexpected shape; not rebuilding it')
  }
  const createNew = tableSql
    .replace(TABLE_NAME, 'CREATE TABLE messages_new')
    .replace(TYPE_CHECK_TAIL, "$1, 'notice'$2")
  const indexes = textColumnValues(
    this.db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'messages' AND sql IS NOT NULL"
      )
      .all(),
    'sql'
  )
  const columns = textColumnValues(
    this.db.prepare('PRAGMA table_info(messages)').all(),
    'name'
  ).join(', ')
  const sequenceRow = this.db
    .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'messages'")
    .get()
  const sequence = sequenceRow ? numberColumn(sequenceRow, 'seq') : null
  this.db.exec(`
    ${createNew};
    INSERT INTO messages_new (${columns}) SELECT ${columns} FROM messages;
    DROP TABLE messages;
    ALTER TABLE messages_new RENAME TO messages;
    ${indexes.map((index) => `${index};`).join('\n')}
  `)
  // Mail cursors read sequence; never hand out a number a deleted message already had.
  if (sequence !== null) {
    this.db
      .prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = 'messages'")
      .run(sequence)
    this.db
      .prepare(
        "INSERT INTO sqlite_sequence (name, seq) SELECT 'messages', ? WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'messages')"
      )
      .run(sequence)
  }
}
