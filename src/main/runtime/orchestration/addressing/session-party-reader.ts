import type { WorkerTerminalResourceRow } from '../terminal-authority/release/worker-terminal-ownership'

/** The two rows naming a session's party reads: the orchestration database, or a poll's batch of them
 *  read off the runtime's thread. */
export type SessionPartyReader = {
  getWorkerTerminalResourceByProcessIncarnation(
    processIncarnation: string
  ): WorkerTerminalResourceRow | undefined
  hasRecordedStructuredWorkerSession(session: string, process: string): boolean
}
