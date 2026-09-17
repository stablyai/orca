import type { AgentSessionStoreState } from './agent-session-record-store-file'
import type { AgentSessionConversationCommandRecord } from '../../shared/agent-session-conversation-command'
import { withAgentSessionRecordOptions } from './agent-session-record-options'

export function commitConversationCommandRecord(
  state: AgentSessionStoreState,
  sessionId: string,
  fence: number,
  command: AgentSessionConversationCommandRecord,
  optionSettlement?: { values: Readonly<Record<string, string>>; now: number }
): void {
  const record = state.records.get(sessionId)
  if (!record || record.lease.runtimeFence !== fence) {
    throw new Error('agent_session_checkpoint_stale')
  }
  const settled =
    optionSettlement === undefined
      ? record
      : withAgentSessionRecordOptions(record, optionSettlement.values, optionSettlement.now)
  state.records.set(sessionId, { ...settled, conversationCommand: command })
  if (
    command.command === 'clear' &&
    command.phase === 'committed' &&
    command.replacementSessionId
  ) {
    if (!state.records.has(command.replacementSessionId)) {
      throw new Error('agent_session_identity_required')
    }
    state.visibleSessionIds.delete(sessionId)
    state.visibleSessionIds.add(command.replacementSessionId)
    state.visibleSessionIdsIndexPresent = true
  }
}
