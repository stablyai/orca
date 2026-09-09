import type SyncDatabase from '../sqlite/sync-database'
import { redactSessionSearchText } from './session-search-redaction'

export const SEARCH_LOG_LIMIT = 5000

/**
 * Local-only telemetry the eval set is rebuilt from. The query text goes
 * through the same redaction the index does, so a credential pasted into the
 * search box never lands here either.
 *
 * Nothing enables this by default: the engine writes a row only when its caller
 * asked for it, because a log write on the query path is a write on what is
 * otherwise a read-only lane. Who turns it on is PR 3b's settings decision.
 */
export function logSessionSearchQuery(
  db: SyncDatabase,
  entry: { query: string; route: string; hits: number; durationMs: number },
  limit: number = SEARCH_LOG_LIMIT
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
  ).run(limit)
}
