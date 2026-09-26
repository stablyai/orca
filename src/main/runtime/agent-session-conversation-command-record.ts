import { agentSessionRefusalError } from '../../shared/agent-session-wire-refusals'
import type { AgentSessionStoreState } from './agent-session-record-store-file'
import { AgentSessionTabTable } from './agent-session-tab-table'
import type { AgentSessionConversationCommandRecord } from '../../shared/agent-session-conversation-command'

export function commitConversationCommandRecord(
  state: AgentSessionStoreState,
  sessionId: string,
  fence: number,
  command: AgentSessionConversationCommandRecord
): void {
  const record = state.records.get(sessionId)
  if (!record || record.lease.runtimeFence !== fence) {
    throw agentSessionRefusalError('agent_session_checkpoint_stale', 'leaseMoved')
  }
  state.records.set(sessionId, { ...record, conversationCommand: command })
  if (
    command.command === 'clear' &&
    command.phase === 'committed' &&
    command.replacementSessionId
  ) {
    if (!state.records.has(command.replacementSessionId)) {
      throw agentSessionRefusalError('agent_session_identity_required', 'recordMissing')
    }
    state.sessionTabs ??= new AgentSessionTabTable()
    state.sessionTabs.move(sessionId, command.replacementSessionId)
  }
}
