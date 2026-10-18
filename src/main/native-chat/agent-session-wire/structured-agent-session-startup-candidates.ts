// The chats startup names to the host's retry from their records alone, beside the generation ends
// the restart reconcile signals itself: an owner still latched in recovery, an owner a runtime this
// one replaced still holds (its reconcile has not run), and a rewind left in doubt. A chat whose
// lease was already released owes nothing a record can show; whatever its journal holds settles
// when a reader first opens it (`StructuredAgentSessionRetry.opened`).

import type { AgentSessionRecordStore } from '../../runtime/agent-session-record-store'

export function structuredAgentSessionRecoveryCandidates(
  store: Pick<AgentSessionRecordStore, 'listRecords' | 'replacedRuntime'>
): string[] {
  return store
    .listRecords()
    .filter(
      ({ sessionId, lease, rewind }) =>
        lease.handoffStage === 'recovering' ||
        (lease.claimStatus !== 'released' && store.replacedRuntime(sessionId) !== undefined) ||
        rewind?.phase === 'prepared' ||
        rewind?.phase === 'provider-succeeded'
    )
    .map(({ sessionId }) => sessionId)
}
