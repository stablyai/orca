// A chat tab a host with no window shows, saved in its layout as a window saves its own, so the
// layout is a complete record of the host's tabs.

import type { AgentType } from '../../shared/agent-status-types'
import type { ExecutionHostId } from '../../shared/execution-host'
import { applyLayoutCommand } from '../../shared/workspace-layout/workspace-layout-commands'
import { loadWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../shared/workspace-layout/workspace-layout-minted-ids'
import type { CommandOf } from '../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-model'
import { saveWorkspaceLayout } from '../../shared/workspace-layout/workspace-layout-save'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { randomUUID } from 'node:crypto'
import { getStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import { structuredAgentSessionTabId } from '../../shared/structured-agent-session-projection'

export type ChatTabChange =
  | { open: { sessionId: string; agent: AgentType; tabId: string } }
  | { close: string }

/** A chat tab change as main's layout command: a window's, which routes by the chat's tab. */
export type ChatTabLayoutCommand =
  | (CommandOf<'openAgentSessionTab'> & { tabId: string })
  | (CommandOf<'closeTabs'> & { tabIds: [string] })

/**
 * One change against the workspace's layout as loaded now: a chat opens in the active group (while
 * the workspace still holds it) unless a tab shows it, and a close drops the chat's tab. Null when
 * nothing changes. Main's queue and the windowless save both decide through it.
 */
export function chatTabLayoutCommand(
  workspace: WorkspaceLayout | undefined,
  activeGroupId: string | undefined,
  worktreeId: string,
  change: ChatTabChange
): ChatTabLayoutCommand | null {
  // A remembered group the workspace no longer holds names nothing: the open mints its own.
  const groupId = workspace?.groups.some((group) => group.id === activeGroupId)
    ? activeGroupId
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
  const open = { type: 'openAgentSessionTab', workspace: worktreeId, ...change.open } as const
  return groupId ? { ...open, groupId } : open
}

/** The layout loaded from a partition, with the worktree's remembered active group. */
export function loadChatTabLayout(
  hostId: ExecutionHostId,
  session: WorkspaceSessionState,
  worktreeId: string
) {
  const loaded = loadWorkspaceLayout(hostId, session, nameBasedLoadContext())
  return { loaded, activeGroupId: loaded.desktopView.activeGroupIdByWorktree?.[worktreeId] }
}

/** The partition with the worktree's chat tabs changed in one layout load; null when unchanged. */
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

/** The id the window, the index and status updates all address the chat's tab by. */
export function chatTabId(sessionId: string): string {
  return (
    getStructuredAgentSessionHost()?.getSessionTabId?.(sessionId) ??
    structuredAgentSessionTabId(sessionId)
  )
}
