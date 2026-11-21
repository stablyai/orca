// The two rows naming a session's party, for many sessions in two queries: a chat list asks for every
// chat at once, and a chat is no worker, so one lookup per chat would all miss.
import type { OrchestrationDbConnection } from '../orchestration-db'
import { WORKER_TERMINAL_RESOURCE_COLUMN_LIST } from '../row-column-lists'
import { structuredWorkerProcessIncarnation } from '../../terminal-authority/structured-sessions/structured-worker-incarnation'
import type { WorkerTerminalResourceRow } from '../../terminal-authority/release/worker-terminal-ownership'

export type SessionPartyRows = {
  sessionId: string
  resource: WorkerTerminalResourceRow | null
  recordedWorker: boolean
}

// Newest first, so the first row per process is the one `getWorkerTerminalResourceByProcessIncarnation` reads.
const RESOURCES_BY_PROCESS_SQL = `
  SELECT ${WORKER_TERMINAL_RESOURCE_COLUMN_LIST} FROM worker_terminal_resources
  WHERE process_incarnation IN (SELECT value FROM json_each(?1))
  ORDER BY updated_at DESC`

const RECORDED_WORKER_SQL = `
  SELECT DISTINCT assignee_orca_session_id AS session, process_incarnation AS process
  FROM dispatch_contexts
  WHERE assignee_orca_session_id IN (SELECT value FROM json_each(?1))`

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
  const processOf = new Map(sessions.map((id) => [id, structuredWorkerProcessIncarnation(id)]))
  const resourceByProcess = new Map<string, WorkerTerminalResourceRow>()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the column list is checked against WorkerTerminalResourceRow.
  const resources = this.db
    .prepare(RESOURCES_BY_PROCESS_SQL)
    .all(JSON.stringify([...processOf.values()])) as WorkerTerminalResourceRow[]
  for (const row of resources) {
    if (row.process_incarnation !== null && !resourceByProcess.has(row.process_incarnation)) {
      resourceByProcess.set(row.process_incarnation, row)
    }
  }
  const recorded = new Set<string>()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both columns are TEXT.
  const assignments = this.db.prepare(RECORDED_WORKER_SQL).all(JSON.stringify(sessions)) as {
    session: string
    process: string | null
  }[]
  for (const { session, process } of assignments) {
    if (process !== null && processOf.get(session) === process) {
      recorded.add(session)
    }
  }
  return [...processOf].map(([sessionId, process]) => ({
    sessionId,
    resource: resourceByProcess.get(process) ?? null,
    recordedWorker: recorded.has(sessionId)
  }))
}

export type SessionPartyRowsMethods = { readSessionPartyRows: typeof readSessionPartyRows }

export function attachSessionPartyRows(ctor: { prototype: object }): void {
  Object.assign(ctor.prototype, { readSessionPartyRows })
}
