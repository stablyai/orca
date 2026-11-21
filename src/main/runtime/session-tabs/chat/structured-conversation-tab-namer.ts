import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { structuredChatDisplayName } from '../../../../shared/agent-session/view/structured-chat-row-name'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { agentSessionRecordShownName } from '../../agent-session/records/agent-session-record-shown-name'

type SavedTabs = () => readonly Tab[] | undefined

/** Names a workspace's chat tabs: the desktop tab's rename, else the chat's saved name; null leaves the agent's default label. */
export function structuredConversationTabNamer(
  workspaceId: string,
  savedTabs: SavedTabs
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

/** First-match rename per chat. The first lookup is a plain early-exit find; later ones share one resumable scan, so no lookup reads past where a find would stop and a pass reads each saved tab at most twice. */
function savedChatTabCustomLabels(
  savedTabs: SavedTabs
): (sessionId: string) => string | null | undefined {
  let tabs: readonly Tab[] | undefined
  let labels: Map<string, string | null> | undefined
  let scanned = 0
  return (sessionId) => {
    if (!tabs) {
      tabs = savedTabs() ?? []
      return tabs.find((tab) => tab.contentType === 'agent-session' && tab.entityId === sessionId)
        ?.customLabel
    }
    labels ??= new Map()
    if (labels.has(sessionId)) {
      return labels.get(sessionId)
    }
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
