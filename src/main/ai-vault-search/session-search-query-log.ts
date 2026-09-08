import type SyncDatabase from '../sqlite/sync-database'
import { redactSessionSearchText } from './session-search-redaction'

const SEARCH_LOG_LIMIT = 5000

/** Telemetry the eval set is rebuilt from; the query text is redacted before it lands. */
export function logSessionSearchQuery(
  db: SyncDatabase,
  entry: { query: string; route: string; hits: number; durationMs: number }
): void {
  db.prepare(
    'INSERT INTO search_log(ts, query, route, hits, duration_ms) VALUES (?, ?, ?, ?, ?)'
  ).run(
    new Date().toISOString(),
    redactSessionSearchText(entry.query),
    entry.route,
    entry.hits,
    entry.durationMs
  )
  db.prepare(
    `DELETE FROM search_log WHERE id <= (
       SELECT id FROM search_log ORDER BY id DESC LIMIT 1 OFFSET ?)`
  ).run(SEARCH_LOG_LIMIT)
}
