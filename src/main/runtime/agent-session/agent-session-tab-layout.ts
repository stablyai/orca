// Persist windowless chat tabs too, so the host layout remains complete.

import type { AgentType } from '../../../shared/agent-status-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { applyLayoutCommand } from '../../../shared/workspace-layout/workspace-layout-commands'
import { loadWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'
import type { CommandOf } from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-model'
import { saveWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-save'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import { randomUUID } from 'node:crypto'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'

/** Placement in the creating client's host-owned group/tab ids. */
export type ChatTabPlacement = { groupId?: string; afterTabId?: string; index?: number }

export type ChatTabChange =
  | {
      open: {
        sessionId: string
        agent: AgentType
        tabId: string
        placement?: ChatTabPlacement
        /** A same-slot switch: the chat takes this tab's slot and the tab closes, in one write. */
        replaces?: string
      }
    }
  | { close: string }

export type ChatTabLayoutCommand =
  | (CommandOf<'openAgentSessionTab'> & { tabId: string })
  | (CommandOf<'closeTabs'> & { tabIds: [string] })

/** Shared by main's queue and windowless saves; null means unchanged. */
export function chatTabLayoutCommand(
  workspace: WorkspaceLayout | undefined,
  activeGroupId: string | undefined,
  worktreeId: string,
  change: ChatTabChange
): ChatTabLayoutCommand | null {
  const placement = 'open' in change ? change.open.placement : undefined
  const holds = (id: string | undefined) => workspace?.groups.some((group) => group.id === id)
  // Prefer an existing client group, then the active group; otherwise open creates one.
  const afterGroupId = workspace?.groups.find((group) =>
    group.tabOrder.includes(placement?.afterTabId ?? '')
  )?.id
  const groupId = holds(placement?.groupId)
    ? placement?.groupId
    : (afterGroupId ?? (holds(activeGroupId) ? activeGroupId : undefined))
  const after = placement?.afterTabId
  const afterTabId =
    after &&
    workspace?.groups.some((group) => group.id === groupId && group.tabOrder.includes(after))
      ? after
      : undefined
  const sessionId = 'close' in change ? change.close : change.open.sessionId
  const tabId =
    workspace?.tabs.find((tab) => tab.kind === 'agent-session' && tab.entityId === sessionId)?.id ??
    null
  if ('close' in change) {
    return tabId ? { type: 'closeTabs', workspace: worktreeId, tabIds: [tabId], force: true } : null
  }
  if (tabId) {
    return null
  }
  const { sessionId: openedSessionId, agent, tabId: openedTabId } = change.open
  return {
    type: 'openAgentSessionTab',
    workspace: worktreeId,
    sessionId: openedSessionId,
    agent,
    tabId: openedTabId,
    ...(groupId ? { groupId } : {}),
    ...(afterTabId
      ? { afterTabId }
      : placement?.index !== undefined
        ? { index: placement.index }
        : {}),
    ...(change.open.replaces ? { replaces: { tabId: change.open.replaces } } : {})
  }
}

export function loadChatTabLayout(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  worktreeId: string
) {
  const loaded = loadWorkspaceLayout(hostId, session, nameBasedLoadContext())
  return { loaded, activeGroupId: loaded.desktopView.activeGroupIdByWorktree?.[worktreeId] }
}

export function withChatTabChanges(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  worktreeId: string,
  changes: readonly ChatTabChange[]
): WorkspaceSessionState | null {
  const { loaded, activeGroupId } = loadChatTabLayout(hostId, session, worktreeId)
  let layout = loaded.layout
  for (const change of changes) {
    const command = chatTabLayoutCommand(
      layout.workspaces[worktreeId],
      activeGroupId,
      worktreeId,
      change
    )
    const applied = command
      ? applyLayoutCommand(layout, command, {
          mintId: randomUUID,
          mintLeafId: randomUUID,
          now: Date.now
        })
      : null
    if (applied?.ok) {
      layout = applied.model
    }
  }
  return layout === loaded.layout ? null : saveWorkspaceLayout({ ...loaded, layout })
}

export function chatTabId(sessionId: string): string {
  return (
    getStructuredAgentSessionHost()?.getSessionTabId?.(sessionId) ??
    structuredAgentSessionTabId(sessionId)
  )
}

/** Select in the existing view without rebuilding membership from a partial runtime snapshot. */
/** Whether a same-slot replace may take the selection from this tab in the saved view: unless
 *  another tab of its group holds it. */
export function savedTabHoldsSelection(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  worktreeId: string,
  tabId: string
): boolean {
  const { loaded } = loadChatTabLayout(hostId, session, worktreeId)
  const group = loaded.layout.workspaces[worktreeId]?.groups.find((row) =>
    row.tabOrder.includes(tabId)
  )
  const active = group && loaded.desktopView.groups[worktreeId]?.[group.id]?.activeTabId
  return active == null || active === tabId
}

export function withSelectedChatTab(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  worktreeId: string,
  sessionId: string
): WorkspaceSessionState | null {
  const { loaded } = loadChatTabLayout(hostId, session, worktreeId)
  const workspace = loaded.layout.workspaces[worktreeId]
  const tab = workspace?.tabs.find(
    (row) => row.kind === 'agent-session' && row.entityId === sessionId
  )
  const group = tab && workspace?.groups.find((row) => row.tabOrder.includes(tab.id))
  if (!tab || !group) {
    return null
  }
  const view = loaded.desktopView
  return saveWorkspaceLayout({
    ...loaded,
    desktopView: {
      ...view,
      activeTabTypeByWorktree: { ...view.activeTabTypeByWorktree, [worktreeId]: 'agent-session' },
      activeFileIdByWorktree: { ...view.activeFileIdByWorktree, [worktreeId]: tab.id },
      activeGroupIdByWorktree: { ...view.activeGroupIdByWorktree, [worktreeId]: group.id },
      groups: {
        ...view.groups,
        [worktreeId]: {
          ...view.groups[worktreeId],
          [group.id]: {
            ...view.groups[worktreeId]?.[group.id],
            activeTabId: tab.id
          }
        }
      }
    }
  })
}
