// The two rows naming a session's party, for many sessions in one query: a chat list asks for every
// chat at once, and a chat is no worker, so one lookup per chat would all miss.
import type { OrchestrationDbConnection } from '../orchestration-db'
import { selectColumns, WORKER_TERMINAL_RESOURCE_COLUMNS } from '../row-column-lists'
import { structuredWorkerProcessIncarnation } from '../../terminal-authority/structured-sessions/structured-worker-incarnation'
import type { WorkerTerminalResourceRow } from '../../terminal-authority/release/worker-terminal-ownership'

export type SessionPartyRows = {
  sessionId: string
  resource: WorkerTerminalResourceRow | null
  recordedWorker: boolean
}

// Per session, as the point lookups ask: the newest terminal row for its process, and whether any
// Dispatch recorded it as a worker (stopping at the first, however long its history).
const SESSION_PARTY_ROWS_SQL = `
  SELECT json_extract(s.value, '$[0]') AS session_id, ${selectColumns(WORKER_TERMINAL_RESOURCE_COLUMNS, 'r')},
    EXISTS (
      SELECT 1 FROM dispatch_contexts d
      WHERE d.assignee_orca_session_id = json_extract(s.value, '$[0]')
        AND d.process_incarnation = json_extract(s.value, '$[1]')
    ) AS recorded_worker
  FROM json_each(?1) AS s
  LEFT JOIN worker_terminal_resources r ON r.rowid = (
    SELECT rowid FROM worker_terminal_resources
    WHERE process_incarnation = json_extract(s.value, '$[1]')
    ORDER BY updated_at DESC LIMIT 1
  )`

/** For each session, what `getWorkerTerminalResourceByProcessIncarnation` and
 *  `hasRecordedStructuredWorkerSession` read for it. */
export function readSessionPartyRows(
  this: OrchestrationDbConnection,
  sessionIds: readonly string[]
): SessionPartyRows[] {
  const sessions = [...new Set(sessionIds)]
  if (sessions.length === 0) {
    return []
  }
  const pairs = sessions.map((id) => [id, structuredWorkerProcessIncarnation(id)])
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: session_id and recorded_worker are added to the worker_terminal_resources columns.
  const rows = this.db.prepare(SESSION_PARTY_ROWS_SQL).all(JSON.stringify(pairs)) as (Record<
    string,
    unknown
  > & { session_id: string; recorded_worker: number; id: string | null })[]
  return rows.map(({ session_id: sessionId, recorded_worker: recordedWorker, ...resource }) => ({
    sessionId,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a joined row carries every worker_terminal_resources column.
    resource: resource.id === null ? null : (resource as WorkerTerminalResourceRow),
    recordedWorker: recordedWorker === 1
  }))
}

export type SessionPartyRowsMethods = { readSessionPartyRows: typeof readSessionPartyRows }

export function attachSessionPartyRows(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, { readSessionPartyRows })
}
