import type SyncDatabase from '../sqlite/sync-database'

// Why: OpenCode's usage scanner and the AI Vault session scanner both need to
// probe the opencode.db schema shape across multiple DB generations. Centralizing
// the probes here avoids two private copies and keeps the contract testable.
type Database = SyncDatabase.Database

/**
 * Check whether a table exists in the given SQLite database.
 * @param db - A readonly or read-write SyncDatabase instance.
 * @param tableName - The table name to look up in sqlite_master.
 * @returns `true` if the table exists, `false` otherwise.
 */
export function tableExists(db: Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { found?: number } | undefined
  return row?.found === 1
}

/**
 * Check whether a column exists on a table in the given SQLite database.
 * @param db - A readonly or read-write SyncDatabase instance.
 * @param tableName - The table to inspect via PRAGMA table_info.
 * @param columnName - The column name to find.
 * @returns `true` if the column exists on the table, `false` otherwise.
 */
export function columnExists(db: Database, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as { name?: string }[]
  return rows.some((row) => row.name === columnName)
}
