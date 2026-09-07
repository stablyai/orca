import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { ConversationReplacement } from '../native-chat/agent-session-wire/structured-conversation-command'

export function replaceConversationInSnapshot(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  replacement: ConversationReplacement
): RuntimeMobileSessionTabsSnapshot {
  if (snapshot.worktree !== replacement.workspaceId) {
    return snapshot
  }
  const source = snapshot.tabs.find(
    (tab) => tab.type === 'agent-session' && tab.sessionId === replacement.sourceSessionId
  )
  if (!source) {
    return snapshot
  }
  const id = `agent-session:${replacement.sessionId}`
  const rename = (value: string | null) => (value === source.id ? id : value)
  return {
    ...snapshot,
    snapshotVersion: snapshot.snapshotVersion + 1,
    activeTabId: rename(snapshot.activeTabId),
    tabs: snapshot.tabs
      .filter((tab) => tab.id !== id)
      .map((tab) =>
        tab.id === source.id
          ? {
              ...tab,
              type: 'agent-session' as const,
              id,
              sessionId: replacement.sessionId,
              agent: replacement.agent,
              title: replacement.agent === 'claude' ? 'Claude Chat' : 'Codex Chat',
              replacesSessionId: replacement.sourceSessionId
            }
          : tab
      ),
    tabGroups: snapshot.tabGroups?.map((group) => ({
      ...group,
      tabOrder: [...new Set(group.tabOrder.map((entry) => rename(entry)!))],
      activeTabId: rename(group.activeTabId),
      recentTabIds: group.recentTabIds?.map((entry) => rename(entry)!)
    }))
  }
}
