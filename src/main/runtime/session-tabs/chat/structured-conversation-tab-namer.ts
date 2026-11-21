import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { structuredChatDisplayName } from '../../../../shared/agent-session/view/structured-chat-row-name'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { agentSessionRecordShownName } from '../../agent-session/records/agent-session-record-shown-name'

/** Names a workspace's chat tabs: the desktop tab's rename, else the chat's saved name; null leaves the agent's default label. */
export function structuredConversationTabNamer(
  workspaceId: string,
  savedTabs: () => readonly Tab[] | undefined
): (sessionId: string) => string | null {
  const customLabelFor = savedChatTabCustomLabels(savedTabs)
  return (sessionId) => {
    const store = getStructuredAgentSessionHost()?.deps?.store
    const record = store?.getConversation(sessionId)
    const conversationName =
      store && record?.location.workspaceId === workspaceId
        ? agentSessionRecordShownName(store, record)
        : null
    return structuredChatDisplayName(customLabelFor(sessionId), conversationName, '') || null
  }
}

/** First-match rename per chat; each lookup resumes the scan where the last stopped, so one pass reads each saved tab at most once. */
function savedChatTabCustomLabels(
  savedTabs: () => readonly Tab[] | undefined
): (sessionId: string) => string | null | undefined {
  let tabs: readonly Tab[] | undefined
  let scanned = 0
  const labels = new Map<string, string | null>()
  return (sessionId) => {
    if (labels.has(sessionId)) {
      return labels.get(sessionId)
    }
    tabs ??= savedTabs() ?? []
    while (scanned < tabs.length) {
      const tab = tabs[scanned++]
      if (tab.contentType !== 'agent-session' || labels.has(tab.entityId)) {
        continue
      }
      labels.set(tab.entityId, tab.customLabel)
      if (tab.entityId === sessionId) {
        return tab.customLabel
      }
    }
    return undefined
  }
}
