import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { structuredChatDisplayName } from '../../../../shared/agent-session/view/structured-chat-row-name'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import { agentSessionRecordShownName } from '../../agent-session/records/agent-session-record-shown-name'

/** Names a workspace's chat tabs: the desktop tab's rename, else the chat's saved name; null leaves the agent's default label. */
export function structuredConversationTabNamer(
  workspaceId: string,
  savedTabs: () => readonly Tab[] | undefined
): (sessionId: string) => string | null {
  // Indexed on first use so one projection reads the saved tabs once, not once per chat.
  let customLabels: ReadonlyMap<string, string | null> | undefined
  return (sessionId) => {
    customLabels ??= agentSessionTabCustomLabels(savedTabs())
    const store = getStructuredAgentSessionHost()?.deps?.store
    const record = store?.getConversation(sessionId)
    const conversationName =
      store && record?.location.workspaceId === workspaceId
        ? agentSessionRecordShownName(store, record)
        : null
    return structuredChatDisplayName(customLabels.get(sessionId), conversationName, '') || null
  }
}

/** The first saved chat tab's rename per session, as a first-match find would pick. */
function agentSessionTabCustomLabels(
  tabs: readonly Tab[] | undefined
): ReadonlyMap<string, string | null> {
  const labels = new Map<string, string | null>()
  for (const tab of tabs ?? []) {
    const sessionId = tab.contentType === 'agent-session' ? tab.entityId : null
    if (sessionId !== null && !labels.has(sessionId)) {
      labels.set(sessionId, tab.customLabel)
    }
  }
  return labels
}
