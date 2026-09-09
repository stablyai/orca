import type SyncDatabase from '../sqlite/sync-database'

export const SEARCH_LOG_LIMIT = 5000

/**
 * Local-only telemetry the eval set is rebuilt from.
 *
 * The query is stored as typed, for the reason PR 2 gives for not redacting
 * transcript content: this file sits beside an index that already holds the
 * user's own plaintext, so a second copy of what they typed is not a new
 * exposure. What may leave the machine is a transport policy and belongs where
 * the wire is.
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
  ).run(new Date().toISOString(), entry.query, entry.route, entry.hits, entry.durationMs)
  db.prepare(
    `DELETE FROM search_log WHERE id <= (
       SELECT id FROM search_log ORDER BY id DESC LIMIT 1 OFFSET ?)`
  ).run(limit)
}
