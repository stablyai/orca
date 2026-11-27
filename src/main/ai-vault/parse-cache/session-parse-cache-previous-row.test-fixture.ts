import SyncDatabase from '../../sqlite/sync-database'
import { SESSION_PARSE_CACHE_SCHEMA_VERSION } from './session-parse-cache-database'
import type { PersistedSessionParseCacheEntry } from './session-parse-cache-store'

/** Snapshot of a cache written before parser-specific repair markers existed. */
export function writePreviousSessionParseRows(
  path: string,
  rows: readonly [string, PersistedSessionParseCacheEntry][]
): void {
  const db = new SyncDatabase(path)
  try {
    db.exec(`
      CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE rows(path TEXT PRIMARY KEY, mtime_ms REAL NOT NULL, size_bytes INTEGER,
        platform TEXT NOT NULL, sidecar TEXT, session TEXT NOT NULL,
        skipped_records TEXT NOT NULL, seen_at INTEGER NOT NULL);
    `)
    db.prepare('INSERT INTO meta VALUES (?, ?)').run(
      'schema_version',
      String(SESSION_PARSE_CACHE_SCHEMA_VERSION)
    )
    const insert = db.prepare('INSERT INTO rows VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    for (const [key, row] of rows) {
      insert.run(
        key,
        row.mtimeMs,
        row.sizeBytes,
        row.platform,
        null,
        JSON.stringify(row.session),
        '[]',
        1784109600000
      )
    }
  } finally {
    db.close()
  }
}
