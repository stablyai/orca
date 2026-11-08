import type Database from '../../sqlite/sync-database'
import { JOURNAL_SQL_NAMED_TURN_INDEX } from './journal-sql-item-schema'
import { journalSqlProjectionSchema } from './journal-sql-projection-schema'

const STATUS_COLUMNS = [
  ['message_role', 'TEXT'],
  ['command_entry', 'INTEGER NOT NULL DEFAULT 0'],
  ['lifecycle_state', 'TEXT'],
  ['assistant_prose', 'INTEGER NOT NULL DEFAULT 0'],
  ['turn_scope_kind', 'TEXT'],
  ['producer_agent_id', 'TEXT'],
  ['producer_parent_ref', 'TEXT'],
  ['producer_attempt', 'INTEGER']
] as const

function normalizedIndex(sql: string): string {
  return sql
    .replace(/IF NOT EXISTS/gi, '')
    .replace(/[;\s]+/g, '')
    .toLowerCase()
}

/** Writable-owner DDL shares a transaction with additions and replacement indexes. */
export function initializeJournalSqlProjection(db: Database.Database): void {
  db.exec('SAVEPOINT journal_projection_schema')
  try {
    const columns = new Set(
      db
        .prepare('PRAGMA table_info(journal_proj_items)')
        .all()
        .map((row) => row.name)
    )
    if (columns.size > 0) {
      for (const [name, declaration] of STATUS_COLUMNS) {
        if (!columns.has(name)) {
          db.exec(`ALTER TABLE journal_proj_items ADD COLUMN ${name} ${declaration}`)
        }
      }
    }
    const namedTurn = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='journal_proj_items_named_turn'"
      )
      .get()?.sql
    if (
      typeof namedTurn === 'string' &&
      normalizedIndex(namedTurn) !== normalizedIndex(JOURNAL_SQL_NAMED_TURN_INDEX)
    ) {
      db.exec('DROP INDEX journal_proj_items_named_turn')
    }
    db.exec(journalSqlProjectionSchema())
    db.exec('RELEASE journal_projection_schema')
  } catch (error) {
    db.exec('ROLLBACK TO journal_projection_schema; RELEASE journal_projection_schema')
    throw error
  }
}
