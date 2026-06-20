import type SyncDatabase from './sync-database'

// Why: OpenCode's usage scanner and the AI Vault session scanner both need to
// probe SQLite schema shape across multiple DB generations. Centralizing the
// probes here avoids two private copies and keeps the contract testable.
type Database = SyncDatabase.Database

export function tableExists(db: Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { found?: number } | undefined
  return row?.found === 1
}

export function columnExists(db: Database, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as { name?: string }[]
  return rows.some((row) => row.name === columnName)
}
