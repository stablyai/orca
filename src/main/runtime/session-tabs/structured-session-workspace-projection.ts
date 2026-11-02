import type {
  RuntimeMobileSessionAgentTab,
  RuntimeMobileSessionTabsSnapshot
} from '../../../shared/runtime-types'
import type { StructuredAgentId } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle'
import { defaultAgentChatLabel } from '../../../shared/agent-session/agent-session-chat-label'
import {
  isReopenedChatTabId,
  isStructuredAgentSessionHostTabId
} from '../../../shared/agent-session/view/structured-agent-session-host-tab-id'
import { withStructuredSessionChatTabs } from './structured-session-tab-publication'

/** What one batch knows about chats, read once for every workspace it projects. */
export type StructuredWorkspaceChatContext = {
  /** The chat behind a tab ID its owner lists, or null when this host has no such chat. */
  sessionOfTab: (tabId: string) => string | null
  /** The chat's agent when its record places it in this workspace; null when it shows elsewhere. */
  placedChat: (workspaceId: string, sessionId: string) => { agent: StructuredAgentId } | null
}

export type StructuredWorkspaceProjection =
  | { kind: 'complete'; snapshot: RuntimeMobileSessionTabsSnapshot }
  | { kind: 'unavailable' }

/** One workspace's complete frame: its owner's own rows and layout, plus a row for every chat
 *  the owner lists whose record still places it here. Without the owner's content there is no
 *  complete frame, only `unavailable`; a frame never stands in for content it was not given. */
export function completeStructuredWorkspaceProjection(
  owner: RuntimeMobileSessionTabsSnapshot | null,
  memberTabIds: Iterable<string>,
  context: StructuredWorkspaceChatContext
): StructuredWorkspaceProjection {
  if (!owner) {
    return { kind: 'unavailable' }
  }
  const listed = new Set<string>()
  for (const tab of owner.tabs) {
    if (tab.type === 'agent-session') {
      listed.add(tab.sessionId)
    }
  }
  const added: RuntimeMobileSessionAgentTab[] = []
  for (const tabId of memberTabIds) {
    const sessionId = context.sessionOfTab(tabId)
    const chat =
      sessionId && !listed.has(sessionId) && context.placedChat(owner.worktree, sessionId)
    if (!sessionId || !chat) {
      continue
    }
    listed.add(sessionId)
    added.push({
      type: 'agent-session',
      id: tabId,
      title: defaultAgentChatLabel(chat.agent),
      sessionId,
      agent: chat.agent,
      isActive: false
    })
  }
  return {
    kind: 'complete',
    snapshot: added.length ? withStructuredSessionChatTabs(owner, owner.worktree, added) : owner
  }
}

/** Chat tab IDs a frame's own layout lists, rows or not: a window publishes its chats only as
 *  group order, never as rows. */
export function structuredChatTabIdsListedBy(
  snapshot: Pick<RuntimeMobileSessionTabsSnapshot, 'tabGroups'>
): string[] {
  return (snapshot.tabGroups ?? []).flatMap((group) =>
    group.tabOrder.filter((id) => isStructuredAgentSessionHostTabId(id) || isReopenedChatTabId(id))
  )
}
