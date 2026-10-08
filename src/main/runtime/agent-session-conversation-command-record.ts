import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import type { AgentSessionStoreState } from './agent-session-store-state'
import { AgentSessionTabTable } from './agent-session-tab-table'
import { foundAgentSessionRecord } from './agent-session-record-founding'
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
  if (
    command.command === 'clear' &&
    command.phase === 'committed' &&
    command.replacementSessionId
  ) {
    if (!state.records.has(command.replacementSessionId)) {
      throw agentSessionRefusalError('agent_session_identity_required', { reason: 'recordMissing' })
    }
    state.sessionTabs ??= new AgentSessionTabTable()
    state.sessionTabs.move(sessionId, command.replacementSessionId)
  }
}

export type AgentSessionConversationClear = {
  sessionId: string
  fence: number
  command: AgentSessionConversationCommandRecord & { replacementSessionId: string }
  claimKeyId: string
  now: number
}

/** A /clear as one write: the conversation it continues in, founded from the source's identity,
 *  and the marker pointing there. Neither can land without the other. */
export function commitConversationClearRecord(
  state: AgentSessionStoreState,
  clear: AgentSessionConversationClear
): void {
  const source = state.records.get(clear.sessionId)
  const replacementId = clear.command.replacementSessionId
  if (!source) {
    throw agentSessionRefusalError('agent_session_checkpoint_stale', { reason: 'leaseMoved' })
  }
  if (state.records.has(replacementId) || state.unreadableRecords.has(replacementId)) {
    throw agentSessionRefusalError('agent_session_conflict', { reason: 'sessionExists' })
  }
  state.records.set(
    replacementId,
    foundAgentSessionRecord({ ...source, sessionId: replacementId }, clear)
  )
  commitConversationCommandRecord(state, clear.sessionId, clear.fence, clear.command)
}
