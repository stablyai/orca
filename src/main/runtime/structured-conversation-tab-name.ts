import { defaultAgentChatLabel } from '../../shared/agent-session-chat-label'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'

/** Provider metadata changes the base title; manual labels remain client-owned. */
export function renameStructuredConversationTab(
  snapshot: RuntimeMobileSessionTabsSnapshot | undefined,
  input: { sessionId: string; conversationName: string | null }
): RuntimeMobileSessionTabsSnapshot | null {
  const id = `agent-session:${input.sessionId}`
  const target = snapshot?.tabs.find((tab) => tab.id === id)
  if (!snapshot || target?.type !== 'agent-session') {
    return null
  }
  const title = input.conversationName ?? defaultAgentChatLabel(target.agent)
  if (target.title === title) {
    return null
  }
  return {
    ...snapshot,
    snapshotVersion: snapshot.snapshotVersion + 1,
    tabs: snapshot.tabs.map((tab) => (tab.id === id ? { ...tab, title } : tab))
  }
}
