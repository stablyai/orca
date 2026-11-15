import Database from '../../../sqlite/sync-database'
import { ensureJournalAdditiveTables } from './journal-database'
import {
  createAgentSessionRecordTablesSql,
  createJournalTablesSql
} from './journal-database-schema'

/**
 * Opens the original journal read-only, shaped as this build's writable open would have left it.
 * A table an older build never created reads as empty through a private TEMP table, so the file
 * itself is never written. Columns added later are optional in their row readers.
 */
export function openJournalLegacySource(
  filename: string,
  options: { timeout?: number } = {}
): Database.Database {
  const source = new Database(filename, { readonly: true, fileMustExist: true, ...options })
  try {
    presentCurrentSchema(source)
    return source
  } catch (error) {
    source.close()
    throw error
  }
}

function presentCurrentSchema(source: Database.Database): void {
  const current = new Database(':memory:')
  try {
    current.exec(createJournalTablesSql() + createAgentSessionRecordTablesSql())
    ensureJournalAdditiveTables(current)
    const tables = current
      .prepare(
        "SELECT name, sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'"
      )
      .all()
    for (const { name, sql } of tables) {
      if (!source.prepare('SELECT 1 FROM main.sqlite_schema WHERE name=?').get(name)) {
        source.exec(String(sql).replace(/^CREATE TABLE /, 'CREATE TEMP TABLE '))
      }
    }
  } finally {
    current.close()
  }
}
