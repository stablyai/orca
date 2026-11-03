import { createHash } from 'node:crypto'
import {
  cancelAgentSessionUsageLimitContinue,
  type UsageLimitContinueIdentity
} from '../../../shared/agent-session/lifecycle/agent-session-usage-limit-continue'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import type { AgentSessionRewindRecord } from '../../../shared/agent-session/lifecycle/agent-session-rewind'
import type { AgentSessionStoreState } from './records/agent-session-store-state'
import { settleAgentSessionOperationInto } from './ownership/agent-session-operation-admission'
import {
  agentSessionProviderHandleChainHead,
  appendAgentSessionProviderHandleLink
} from '../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import { agentSessionProviderHandleKey } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle-encoding'
import type { AgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-record'

const LINK_ID_TOKEN = /^[A-Za-z0-9_-]{1,128}$/

/** Link ids are short tokens; a fork named by a file path (Pi) is named by its digest instead. */
function rewindLinkId(forkSessionId: string): string {
  const id = `rewind-${forkSessionId}`
  return LINK_ID_TOKEN.test(id)
    ? id
    : `rewind-${createHash('sha256').update(forkSessionId).digest('hex').slice(0, 40)}`
}

export function rewindProviderChain(
  record: Pick<AgentSessionRecord, 'providerHandleChain'>,
  rewind: Pick<AgentSessionRewindRecord, 'providerFork'>,
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
    linkId: rewindLinkId(fork.sessionId),
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
  cursor: AgentJournalCursor,
  cancel?: UsageLimitContinueIdentity
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
    ...(cancel ? cancelAgentSessionUsageLimitContinue(record, cancel) : record),
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
