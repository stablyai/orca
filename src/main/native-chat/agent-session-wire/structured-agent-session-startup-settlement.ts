// What the host owes its chats when it comes up as a new instance: what the earlier process left.
// Run after the whole-host restart reconcile, in the background, for EVERY chat on record: no
// stored "settled" mark says which are owed, so each is derived from its journal.
//
// Each chat goes to its reconciliation worker with its startup share owed
// (`structured-agent-session-reconciliation-pass.ts`): the worker takes a background slot outside
// the chat's action lane, replays a closed chat's journal as its own read (published to no status
// surface: only a chat a reader or the restorer opens is), and enters the lane only for the short
// recheck and its writes. So a send, a start or a read of a chat late in the scan never waits
// behind its share, and a chat a reader opens moves ahead of the rest. A share that fails is not
// done: the worker retries it, up to its bound.

import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionReconciliation } from './structured-agent-session-reconciliation-worker'

/** Resolves once every chat's first attempt finished, whatever it found. */
export function scanStructuredAgentSessionsAtStartup(
  store: Pick<AgentSessionRecordStore, 'listRecords'>,
  reconciliation: Pick<StructuredAgentSessionReconciliation, 'signal' | 'attempted'>
): Promise<void> {
  const sessionIds = store.listRecords().map((record) => record.sessionId)
  for (const sessionId of sessionIds) {
    reconciliation.signal(sessionId, { startup: true })
  }
  return Promise.all(sessionIds.map((sessionId) => reconciliation.attempted(sessionId))).then(
    () => undefined
  )
}
