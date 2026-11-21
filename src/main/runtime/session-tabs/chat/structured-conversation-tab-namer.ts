import { getStructuredAgentSessionHost } from '../../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { structuredChatDisplayName } from '../../../../shared/agent-session/view/structured-chat-row-name'
import type { Tab } from '../../../../shared/workspace-layout/tab-groups/tab-types'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import { agentSessionRecordShownName } from '../../agent-session/records/agent-session-record-shown-name'

type SavedTabs = () => readonly Tab[] | undefined

/** Names every chat tab in one projected snapshot. */
export function structuredConversationTabNamer(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  savedTabs: SavedTabs
): (sessionId: string) => string | null {
  let chats = 0
  for (const tab of snapshot.tabs) {
    chats += tab.type === 'agent-session' ? 1 : 0
  }
  return chatTabNamer(snapshot.worktree, savedTabs, chats)
}

/** New names for a renamed chat and its open forks, since an older fork's shown name reads its source's. */
export function structuredConversationRetitleNames(
  workspaceId: string,
  snapshot: RuntimeMobileSessionTabsSnapshot,
  sessionId: string,
  savedTabs: SavedTabs
): Map<string, string | null> {
  const store = getStructuredAgentSessionHost()?.deps?.store
  const forks = snapshot.tabs.flatMap((tab) =>
    tab.type === 'agent-session' &&
    store?.getConversation(tab.sessionId)?.forkedFrom?.sessionId === sessionId
      ? [tab.sessionId]
      : []
  )
  const nameFor = chatTabNamer(workspaceId, savedTabs, 1 + forks.length)
  const names = new Map([[sessionId, nameFor(sessionId)]])
  for (const fork of forks) {
    names.set(fork, nameFor(fork))
  }
  return names
}

/** The desktop tab's rename, else the chat's saved name; null leaves the agent's default label. */
function chatTabNamer(
  workspaceId: string,
  savedTabs: SavedTabs,
  lookups: number
): (sessionId: string) => string | null {
  const customLabelFor =
    lookups > 1
      ? savedChatTabCustomLabels(savedTabs)
      : (sessionId: string) =>
          savedTabs()?.find(
            (tab) => tab.contentType === 'agent-session' && tab.entityId === sessionId
          )?.customLabel
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
  savedTabs: SavedTabs
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
