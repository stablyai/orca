import Database from '../../../sqlite/sync-database'
import { ensureJournalAdditiveTables, journalPragmaNumber } from './journal-database'
import { createAgentSessionRecordTablesSql } from './journal-database-schema'

/**
 * Opens the original journal read-only, shaped as this build's writable open would have left it.
 * A table an older build never added reads as empty through a private TEMP table, so the file
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
    current.exec(createAgentSessionRecordTablesSql())
    // Schema 4 created its record tables with its version; a version-4 file without them is damaged.
    const required = journalPragmaNumber(source, 'user_version') >= 4 ? tableNames(current) : []
    ensureJournalAdditiveTables(current)
    const tables = current
      .prepare(
        "SELECT name, sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'"
      )
      .all()
    for (const { name, sql } of tables) {
      if (
        !required.includes(String(name)) &&
        !source.prepare('SELECT 1 FROM main.sqlite_schema WHERE name=?').get(name)
      ) {
        source.exec(String(sql).replace(/^CREATE TABLE /, 'CREATE TEMP TABLE '))
      }
    }
  } finally {
    current.close()
  }
}

function tableNames(db: Database.Database): string[] {
  return db
    .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
    .all()
    .map(({ name }) => String(name))
}
