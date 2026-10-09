import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import { createHash } from 'node:crypto'
import { agentSessionOperationKey } from '../../shared/agent-session-operation-ledger'
import type { AgentSessionStoreState } from './agent-session-store-state'
import type { AgentSessionConversationCommandRecord } from '../../shared/agent-session-conversation-command'

export function commitConversationCommandRecord(
  state: AgentSessionStoreState,
  sessionId: string,
  fence: number,
  command: AgentSessionConversationCommandRecord
): void {
  const record = state.records.get(sessionId)
  if (!record || record.lease.runtimeFence !== fence) {
    throw agentSessionRefusalError('agent_session_checkpoint_stale', { reason: 'leaseMoved' })
  }
  state.records.set(sessionId, { ...record, conversationCommand: command })
}

export type AgentSessionConversationClear = {
  sessionId: string
  fence: number
  command: AgentSessionConversationCommandRecord & {
    command: 'clear'
    phase: 'committed'
    state: 'completed'
  }
  now: number
}

export function providerContextBoundaryForClear(clear: AgentSessionConversationClear) {
  return {
    operationId: createHash('sha256')
      .update(agentSessionOperationKey(clear.command.callerKey, clear.command.operationId))
      .digest('hex'),
    afterFence: clear.fence,
    clearedAt: clear.now
  }
}

/** The record owns the provider boundary; the journal transaction publishes its divider. */
export function commitConversationClearRecord(
  state: AgentSessionStoreState,
  clear: AgentSessionConversationClear
): void {
  const source = state.records.get(clear.sessionId)
  if (!source || source.lease.runtimeFence !== clear.fence) {
    throw agentSessionRefusalError('agent_session_checkpoint_stale', { reason: 'leaseMoved' })
  }
  if (source.lease.ownerProcess !== null || source.lease.claimStatus !== 'released') {
    throw agentSessionRefusalError('agent_session_ownership_unknown', { reason: 'leaseMoved' })
  }
  state.records.set(clear.sessionId, {
    ...source,
    providerHandleChain: [],
    lease: { ...source.lease, provenHandleLinkId: null },
    conversationCommand: clear.command,
    providerContextBoundary: providerContextBoundaryForClear(clear),
    updatedAt: clear.now
  })
}
