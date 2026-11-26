import { defaultAgentChatLabel } from '../../../../shared/agent-session/conversation-naming/agent-session-chat-label'
import type { RuntimeMobileSessionAgentTab } from '../../../../shared/remote-runtime/session-graph/runtime-mobile-session-tab-contracts'
import type { RuntimeMobileSessionTabsSnapshot } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'

/** Whether a chat is a fork on this host, so phones draw its fork mark. */
export type StructuredConversationForked = (sessionId: string) => boolean

function titledTab(
  tab: RuntimeMobileSessionAgentTab,
  name: string | null | undefined,
  forked: StructuredConversationForked,
  sideChat?: StructuredConversationForked
): RuntimeMobileSessionAgentTab {
  const title = name ?? defaultAgentChatLabel(tab.agent)
  const isFork = forked(tab.sessionId)
  const isSideChat = sideChat?.(tab.sessionId) ?? tab.sideChat === true
  if (
    tab.title === title &&
    (tab.forked === true) === isFork &&
    (tab.sideChat === true) === isSideChat
  ) {
    return tab
  }
  const { forked: _forked, sideChat: _sideChat, ...rest } = tab
  return {
    ...rest,
    title,
    ...(isFork ? { forked: true as const } : {}),
    ...(isSideChat ? { sideChat: true as const } : {})
  }
}

/** Project the one durable conversation name onto each structured tab's display title. */
export function titleStructuredConversationTabs(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  nameFor: (sessionId: string) => string | null | undefined,
  forked: StructuredConversationForked,
  sideChat?: StructuredConversationForked
): RuntimeMobileSessionTabsSnapshot {
  let changed = false
  const tabs = snapshot.tabs.map((tab) => {
    if (tab.type !== 'agent-session') {
      return tab
    }
    const next = titledTab(tab, nameFor(tab.sessionId), forked, sideChat)
    changed ||= next !== tab
    return next
  })
  return changed ? { ...snapshot, tabs } : snapshot
}

/** Apply a saved-session title change with one snapshot fence per workspace. */
export function retitleStructuredConversationTabs(
  snapshot: RuntimeMobileSessionTabsSnapshot,
  names: ReadonlyMap<string, string | null>,
  forked: StructuredConversationForked,
  sideChat?: StructuredConversationForked
): RuntimeMobileSessionTabsSnapshot | null {
  let changed = false
  const tabs = snapshot.tabs.map((tab) => {
    if (tab.type !== 'agent-session' || !names.has(tab.sessionId)) {
      return tab
    }
    const next = titledTab(tab, names.get(tab.sessionId), forked, sideChat)
    changed ||= next !== tab
    return next
  })
  return changed ? { ...snapshot, tabs, snapshotVersion: snapshot.snapshotVersion + 1 } : null
}
