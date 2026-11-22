import type { WorkerTerminalResourceRow } from '../terminal-authority/release/worker-terminal-ownership'
import { structuredWorkerProcessIncarnation } from '../terminal-authority/structured-sessions/structured-worker-incarnation'
import { structuredWorkerIdentities } from '../terminal-authority/structured-sessions/structured-worker-identity'
import type { SessionPartyRows } from '../db/worker-terminal/session-party-rows'

/** The two rows naming a session's party reads: the orchestration database, or a poll's batch of them
 *  read off the runtime's thread. */
export type SessionPartyReader = {
  getWorkerTerminalResourceByProcessIncarnation(
    processIncarnation: string
  ): WorkerTerminalResourceRow | undefined
  hasRecordedStructuredWorkerSession(session: string, process: string): boolean
}

/** The sessions' party rows as a batch read them; a session it did not read asks `db`. */
export function prefetchedSessionParties(
  db: SessionPartyReader,
  rows: readonly SessionPartyRows[]
): SessionPartyReader {
  const bySession = new Map(rows.map((row) => [row.sessionId, row]))
  const byProcess = new Map(
    rows.map((row) => [structuredWorkerProcessIncarnation(row.sessionId), row])
  )
  return {
    getWorkerTerminalResourceByProcessIncarnation: (process) => {
      const read = byProcess.get(process)
      return read
        ? (read.resource ?? undefined)
        : db.getWorkerTerminalResourceByProcessIncarnation(process)
    },
    hasRecordedStructuredWorkerSession: (session, process) => {
      const read = bySession.get(session)
      return read && byProcess.get(process) === read
        ? read.recordedWorker
        : db.hasRecordedStructuredWorkerSession(session, process)
    }
  }
}

/** One batch read of these sessions' party rows: a pass over many chats asks one query, not two each. */
export function readSessionParties(
  db: SessionPartyReader & {
    readSessionPartyRows?: (sessionIds: readonly string[]) => SessionPartyRows[]
  },
  sessionIds: readonly string[]
): SessionPartyReader {
  if (!db.readSessionPartyRows) {
    return db
  }
  // A worker this process holds resolves without either row, as it did before the batch.
  const unknown = sessionIds.filter((id) => !structuredWorkerIdentities.getBySessionId(id))
  return prefetchedSessionParties(db, db.readSessionPartyRows(unknown))
}
