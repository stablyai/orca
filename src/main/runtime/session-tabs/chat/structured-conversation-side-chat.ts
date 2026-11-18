import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'

export function structuredConversationIsSideChat(sessionId: string): boolean {
  return !!getStructuredAgentSessionHost()?.deps.store.getConversation(sessionId)?.sideChat
}
