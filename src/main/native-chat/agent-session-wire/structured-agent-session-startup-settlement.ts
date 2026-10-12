// What the host owes its chats when it comes up as a new instance: what the earlier process left.
// Run after the whole-host restart reconcile, in the background, for EVERY chat on record: no
// stored "settled" mark says which are owed, so the host's retry derives each from its journal
// (`structured-agent-session-reconciliation-pass.ts`). The scan only wakes the retry.
//
// It never decides a lease latched in recovery: that signals a process that may still run, which
// only the visible-tab restore, a start or an attach does, as on every build before this one.
// Their release then wakes the retry again. The retry replays a closed chat in a background slot as
// its own read, published to no status surface, and takes the chat's lane only to write, so a send,
// start or read of a chat late in the scan never waits behind it, and an opened chat goes first.

import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'
import type { StructuredAgentSessionRetry } from './structured-agent-session-reconciliation-retry'

/** Resolves once every chat's first attempt finished, whatever it found. */
export function scanStructuredAgentSessionsAtStartup(
  store: Pick<AgentSessionRecordStore, 'listRecords'>,
  reconciliation: Pick<StructuredAgentSessionRetry, 'signal' | 'attempted'>
): Promise<void> {
  const sessionIds = store.listRecords().map((record) => record.sessionId)
  for (const sessionId of sessionIds) {
    reconciliation.signal(sessionId)
  }
  return Promise.all(sessionIds.map((sessionId) => reconciliation.attempted(sessionId))).then(
    () => undefined
  )
}
