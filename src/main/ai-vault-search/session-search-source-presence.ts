import type SyncDatabase from '../sqlite/sync-database'
import type { SessionSearchSourcePresence } from './session-search-engine-types'

/**
 * Where each session's source stands, read from the index's own `files` table.
 *
 * Why not a stat: a search page of 20 hits would be 20 filesystem round trips
 * on the query path, and on an SSH or WSL host each one can block for as long
 * as the connection takes to answer — the reviewer's F11. The index already
 * records what discovery last proved about every file it read, so the query
 * path reads that instead of asking the disk again.
 *
 * The vocabulary is deliberately short of `missing`. A row here means the index
 * holds a live file record for the session, which is `present`. No row means
 * this read cannot tell whether the source is gone or merely unrecorded, and
 * loss of contact is never evidence of absence
 * (docs/reference/ssh-execution-boundary.md), so it is `unverifiable`. Proving
 * a deletion is the indexer's job and it retires the session's rows outright.
 */
export function sessionSourcePresence(
  db: SyncDatabase,
  sessionRowIds: readonly number[]
): Map<number, SessionSearchSourcePresence> {
  const presence = new Map<number, SessionSearchSourcePresence>(
    sessionRowIds.map((id) => [id, 'unverifiable' as const])
  )
  if (sessionRowIds.length === 0) {
    return presence
  }
  const rows = db
    .prepare(
      `SELECT DISTINCT session_row_id FROM files
       WHERE session_row_id IN (${sessionRowIds.map(() => '?').join(',')})`
    )
    .all(...sessionRowIds) as { session_row_id: number }[]
  for (const row of rows) {
    presence.set(row.session_row_id, 'present')
  }
  return presence
}
