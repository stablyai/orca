// Persist windowless chat tabs too, so the host layout remains complete.

import type { AgentType } from '../../../shared/agent-status/contracts/agent-status-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { applyLayoutCommand } from '../../../shared/workspace-layout/workspace-layout-commands'
import { loadWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-load'
import { nameBasedLoadContext } from '../../../shared/workspace-layout/workspace-layout-minted-ids'
import type { CommandOf } from '../../../shared/workspace-layout/workspace-layout-command-types'
import type { WorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-model'
import { saveWorkspaceLayout } from '../../../shared/workspace-layout/workspace-layout-save'
import type { WorkspaceSessionState } from '../../../shared/workspace-session/workspace-session-state-types'
import { randomUUID } from 'node:crypto'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/host/structured-agent-session-registry'
import { structuredAgentSessionTabId } from '../../../shared/agent-session/view/structured-agent-session-projection'
import { isReopenedChatTabId } from '../../../shared/agent-session/view/structured-agent-session-host-tab-id'
import { resolveChatTabActivation } from './agent-session-tab-identity'

/** Placement in the creating client's host-owned group/tab ids. */
export type ChatTabPlacement = { groupId?: string; afterTabId?: string }

/** Saved layouts and window-owned publications resolve the same captured source placement. */
export function resolveChatTabPlacement(
  groups: readonly { id: string; tabOrder: readonly string[] }[],
  activeGroupId: string | undefined,
  placement?: ChatTabPlacement,
  chats: readonly { id: string; sessionId: string; type: 'agent-session' }[] = []
): ChatTabPlacement {
  const holds = (id: string | undefined) => groups.some((group) => group.id === id)
  // A client without group ids (a phone) names only the tab to follow, so its group is the place.
  const captured = placement?.afterTabId
  let after = captured
  if (
    captured &&
    !groups.some((group) => group.tabOrder.includes(captured)) &&
    !isReopenedChatTabId(captured)
  ) {
    const ordinary = chats.filter(
      (tab) =>
        !isReopenedChatTabId(tab.id) && groups.some((group) => group.tabOrder.includes(tab.id))
    )
    const rowAnchor = resolveChatTabActivation(ordinary, captured)
    after = ordinary.find(
      (tab) =>
        tab.id === rowAnchor ||
        [structuredAgentSessionTabId(tab.sessionId), chatTabId(tab.sessionId)].includes(captured)
    )?.id
  }
  const anchorGroupId = after
    ? groups.find((group) => group.tabOrder.includes(after))?.id
    : undefined
  // Prefer an existing client group, then the anchor's, then the active group; otherwise open creates one.
  const groupId = holds(placement?.groupId)
    ? placement?.groupId
    : (anchorGroupId ?? (holds(activeGroupId) ? activeGroupId : undefined))
  const afterTabId =
    after && groups.some((group) => group.id === groupId && group.tabOrder.includes(after))
      ? after
      : undefined
  return { groupId, afterTabId }
}

export type ChatTabChange =
  | { open: { sessionId: string; agent: AgentType; tabId: string; placement?: ChatTabPlacement } }
  | { close: string; tabId?: string }

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
  const { groupId, afterTabId } = resolveChatTabPlacement(
    workspace?.groups ?? [],
    activeGroupId,
    'open' in change ? change.open.placement : undefined,
    workspace?.tabs.flatMap((tab) =>
      tab.kind === 'agent-session'
        ? [{ id: tab.id, sessionId: tab.entityId, type: 'agent-session' as const }]
        : []
    )
  )
  const sessionId = 'close' in change ? change.close : change.open.sessionId
  const tabId =
    workspace?.tabs.find((tab) => tab.kind === 'agent-session' && tab.entityId === sessionId)?.id ??
    null
  if ('close' in change) {
    return tabId && change.tabId === tabId
      ? { type: 'closeTabs', workspace: worktreeId, tabIds: [tabId], force: true }
      : null
  }
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
