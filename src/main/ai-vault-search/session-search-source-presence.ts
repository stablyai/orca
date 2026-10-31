import type SyncDatabase from '../sqlite/sync-database'
import type { SessionSearchSourcePresence } from './session-search-engine-types'

/** Read indexed presence without filesystem probes; no file row means unverifiable, not deleted. */
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
