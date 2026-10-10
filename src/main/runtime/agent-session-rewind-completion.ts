import type { AgentJournalCursor } from '../../shared/agent-session-journal-types'
import type { AgentSessionRewindRecord } from '../../shared/agent-session-rewind'
import type { AgentSessionStoreState } from './agent-session-store-state'
import { settleAgentSessionOperationInto } from './agent-session-operation-admission'

export function commitAgentSessionRewindCompletion(
  draft: AgentSessionStoreState,
  sessionId: string,
  fence: number,
  rewind: AgentSessionRewindRecord,
  cursor: AgentJournalCursor
): void {
  const record = draft.records.get(sessionId)
  if (
    !record ||
    record.lease.runtimeFence !== fence ||
    record.providerContextBoundary?.operationId !== rewind.contextClearOperationId
  ) {
    throw new Error('agent_session_rewind:stale-context')
  }
  draft.records.set(sessionId, {
    ...record,
    rewind: {
      ...rewind,
      phase: 'completed',
      epoch: cursor.epoch,
      sequence: cursor.sequence,
      retained: []
    }
  })
  settleAgentSessionOperationInto(draft, {
    callerKey: rewind.callerKey,
    operationId: rewind.operationId,
    outcome: { status: 'succeeded', sessionId, rewind: { itemId: rewind.itemId, ...cursor } }
  })
}
