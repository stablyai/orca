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
export type ChatTabPlacement = { groupId?: string; afterTabId?: string }

export type ChatTabChange =
  | { open: { sessionId: string; agent: AgentType; tabId: string; placement?: ChatTabPlacement } }
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
    ...(afterTabId ? { afterTabId } : {})
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
