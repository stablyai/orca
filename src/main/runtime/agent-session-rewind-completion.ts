import type { AgentJournalCursor } from '../../shared/agent-session-journal-types'
import type { AgentSessionRewindRecord } from '../../shared/agent-session-rewind'
import type { AgentSessionStoreState } from './agent-session-store-state'
import { settleAgentSessionOperationInto } from './agent-session-operation-admission'
import {
  agentSessionProviderHandleChainHead,
  agentSessionProviderHandleKey,
  appendAgentSessionProviderHandleLink
} from '../../shared/agent-session-provider-handle'
import type { AgentSessionRecord } from '../../shared/agent-session-record'

function rewindProviderChain(
  record: AgentSessionRecord,
  rewind: AgentSessionRewindRecord,
  fence: number
) {
  const fork = rewind.providerFork
  const head = agentSessionProviderHandleChainHead(record.providerHandleChain)?.handle
  if (!fork?.materialized || head?.nativeId === fork.sessionId) {
    return record.providerHandleChain
  }
  if (!head || head.nativeId !== fork.replacesSessionId) {
    throw new Error('agent_session_rewind:stale-provider')
  }
  return appendAgentSessionProviderHandleLink(record.providerHandleChain, {
    linkId: `rewind-${fork.sessionId}`,
    handle: {
      transport: head.transport,
      agent: head.agent,
      nativeId: fork.sessionId,
      ...(fork.resumeCursor ? { resumeCursor: fork.resumeCursor } : {})
    },
    origin: 'forked',
    mintedAtFence: fence,
    observedAt: Date.now(),
    forkedFromKey: agentSessionProviderHandleKey(head)
  })
}

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
    record.rewind?.operationId !== rewind.operationId ||
    (rewind.contextClearOperationId !== undefined &&
      record.providerContextBoundary?.operationId !== rewind.contextClearOperationId)
  ) {
    throw new Error('agent_session_rewind:stale-context')
  }
  const { retained: _retained, hydrationVerified: _hydrationVerified, ...current } = rewind
  draft.records.set(sessionId, {
    ...record,
    providerHandleChain: rewindProviderChain(record, rewind, fence),
    rewind: {
      ...current,
      phase: 'completed',
      epoch: cursor.epoch,
      ...(rewind.contextClearOperationId ? { sequence: cursor.sequence } : {})
    }
  })
  settleAgentSessionOperationInto(draft, {
    callerKey: rewind.callerKey,
    operationId: rewind.operationId,
    outcome: {
      status: 'succeeded',
      sessionId,
      rewind: {
        itemId: rewind.itemId,
        epoch: cursor.epoch,
        ...(rewind.contextClearOperationId ? { sequence: cursor.sequence } : {})
      }
    }
  })
}
