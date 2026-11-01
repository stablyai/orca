import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { ConversationHistory, ConversationTab } from './conversation-records'

export function createConversationHistoryIndex(history: readonly ConversationHistory[]) {
  const byIdentity = new Map<string, ConversationHistory[]>()
  for (const session of history) {
    const key = session.structuredSession
      ? JSON.stringify([
          session.executionHostId,
          'structured',
          session.structuredSession.workspaceId,
          session.structuredSession.sessionId
        ])
      : JSON.stringify([session.executionHostId, 'native', session.agent, session.sessionId])
    byIdentity.set(key, [...(byIdentity.get(key) ?? []), session])
  }
  return (
    tab: ConversationTab,
    hostId: ExecutionHostId,
    workspaceId: string,
    agent?: string | null
  ) => {
    const key = tab.sessionId
      ? JSON.stringify([hostId, 'structured', workspaceId, tab.sessionId])
      : JSON.stringify([hostId, 'native', agent, tab.agentStatus?.sessionId])
    const candidates = byIdentity.get(key)
    return candidates?.length === 1 ? candidates[0] : undefined
  }
}
