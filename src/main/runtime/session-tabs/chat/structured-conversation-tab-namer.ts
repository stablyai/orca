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
  const savedChatTab = savedChatTabFinder(savedTabs)
  return (sessionId) => {
    const store = getStructuredAgentSessionHost()?.deps?.store
    const record = store?.getConversation(sessionId)
    const conversationName =
      store && record?.location.workspaceId === workspaceId
        ? agentSessionRecordShownName(store, record)
        : null
    return (
      structuredChatDisplayName(savedChatTab(sessionId)?.customLabel, conversationName, '') || null
    )
  }
}

/** Finds each chat's first saved tab; one finder per pass so a pass reads saved tabs O(tabs), not once per chat. */
export function savedChatTabFinder<T extends Pick<Tab, 'contentType' | 'entityId'>>(
  savedTabs: () => readonly T[] | undefined
): (sessionId: string) => T | undefined {
  let tabs: readonly T[] | undefined
  let found: Map<string, T> | undefined
  let scanned = 0
  return (sessionId) => {
    // A lone lookup stays a plain find, with no index to build.
    if (!tabs) {
      tabs = savedTabs() ?? []
      return tabs.find((tab) => tab.contentType === 'agent-session' && tab.entityId === sessionId)
    }
    found ??= new Map()
    const known = found.get(sessionId)
    if (known) {
      return known
    }
    while (scanned < tabs.length) {
      const tab = tabs[scanned++]
      if (tab.contentType !== 'agent-session' || found.has(tab.entityId)) {
        continue
      }
      found.set(tab.entityId, tab)
      if (tab.entityId === sessionId) {
        return tab
      }
    }
    return undefined
  }
}
