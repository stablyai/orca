import type Database from '../../../sqlite/sync-database'

/** One value in this file's key-value metadata, absent as undefined. */
export function readJournalStoreMeta(db: Database.Database, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM agent_session_store_meta WHERE key=?').get(key)
  return row === undefined ? undefined : String(row.value)
}

export function writeJournalStoreMeta(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO agent_session_store_meta (key, value) VALUES (?, ?)').run(
    key,
    value
  )
}
