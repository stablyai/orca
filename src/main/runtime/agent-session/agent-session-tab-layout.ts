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
import { structuredAgentSessionTabId } from '../../../shared/agent-session/view/structured-agent-session-projection'
import { isReopenedChatTabId } from '../../../shared/agent-session/view/structured-agent-session-host-tab-id'

/** Placement in the creating client's host-owned group/tab ids. */
export type ChatTabPlacement = { groupId?: string; afterTabId?: string }

export type ChatTabChange =
  | { open: { sessionId: string; agent: AgentType; tabId: string; placement?: ChatTabPlacement } }
  | { close: string; tabId?: string }

export type ChatTabLayoutCommand =
  | (CommandOf<'openAgentSessionTab'> & { tabId: string })
  | (CommandOf<'closeTabs'> & { tabIds: [string, ...string[]] })

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
  const groupId = holds(placement?.groupId)
    ? placement?.groupId
    : holds(activeGroupId)
      ? activeGroupId
      : undefined
  const after = placement?.afterTabId
  const afterTabId =
    after &&
    workspace?.groups.some((group) => group.id === groupId && group.tabOrder.includes(after))
      ? after
      : undefined
  if ('close' in change) {
    return chatTabCloseCommand(workspace, worktreeId, [change])
  }
  const sessionId = change.open.sessionId
  const tabId =
    workspace?.tabs.find((tab) => tab.kind === 'agent-session' && tab.entityId === sessionId)?.id ??
    null
  if (tabId) {
    return (isReopenedChatTabId(change.open.tabId) || isReopenedChatTabId(tabId)) &&
      tabId !== change.open.tabId
      ? { type: 'closeTabs', workspace: worktreeId, tabIds: [tabId], force: true }
      : null
  }
  const { sessionId: openedSessionId, agent, tabId: openedTabId } = change.open
  return {
    type: 'openAgentSessionTab',
    workspace: worktreeId,
    sessionId: openedSessionId,
    agent,
    tabId: openedTabId,
    ...(groupId ? { groupId } : {}),
    ...(afterTabId ? { afterTabId } : {})
  }
}

/** One command closing every listed chat whose tab here is still the one it names; null when none is. */
export function chatTabCloseCommand(
  workspace: WorkspaceLayout | undefined,
  worktreeId: string,
  closes: readonly Extract<ChatTabChange, { close: string }>[]
): Extract<ChatTabLayoutCommand, { type: 'closeTabs' }> | null {
  // A chat's tab is the first one listing it, as a single close reads it.
  const tabOf = new Map<string, string>()
  for (const tab of workspace?.tabs ?? []) {
    if (tab.kind === 'agent-session' && !tabOf.has(tab.entityId)) {
      tabOf.set(tab.entityId, tab.id)
    }
  }
  const [first, ...rest] = closes.flatMap((change) =>
    change.tabId && tabOf.get(change.close) === change.tabId ? [change.tabId] : []
  )
  return first
    ? { type: 'closeTabs', workspace: worktreeId, tabIds: [first, ...rest], force: true }
    : null
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
    for (let step = 0; step < 2; step++) {
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
      if (!applied?.ok || !('open' in change) || command?.type !== 'closeTabs') {
        break
      }
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
