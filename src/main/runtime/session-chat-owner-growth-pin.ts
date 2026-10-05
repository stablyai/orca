import type { TerminalLayoutSnapshot } from '../../shared/terminal-tab-types'
import {
  pinTerminalChatOwnerOnGrowth,
  resolveTerminalTabViewMode,
  type TerminalTabViewMode
} from '../../shared/terminal-tab-view-mode'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'

/**
 * Backstop for every runtime session commit: a tab whose tree grew from one pane keeps its
 * ownerless chat on that pane, so no runtime writer can store a split chat without an owner.
 * Returns `next` itself when nothing pins.
 */
export function pinSessionChatOwnersOnGrowth(
  prior: WorkspaceSessionState | null | undefined,
  next: WorkspaceSessionState
): WorkspaceSessionState {
  const priorLayouts = prior?.terminalLayoutsByTabId
  const nextLayouts = next.terminalLayoutsByTabId
  if (!priorLayouts || !nextLayouts || priorLayouts === nextLayouts) {
    return next
  }
  let pinned: Record<string, TerminalLayoutSnapshot> | null = null
  for (const [tabId, layout] of Object.entries(nextLayouts)) {
    const priorRoot = priorLayouts[tabId]?.root
    // Why the shape checks first: this runs on every runtime write; only a 1 -> split growth pins.
    if (layout.chatLeafId || priorRoot?.type !== 'leaf' || layout.root?.type !== 'split') {
      continue
    }
    const owner = pinTerminalChatOwnerOnGrowth({
      viewMode: readSessionTerminalTabViewMode(next, tabId),
      chatLeafId: undefined,
      priorRoot,
      nextRoot: layout.root
    })
    if (owner) {
      pinned ??= { ...nextLayouts }
      pinned[tabId] = { ...layout, chatLeafId: owner }
    }
  }
  return pinned ? { ...next, terminalLayoutsByTabId: pinned } : next
}

function readSessionTerminalTabViewMode(
  session: WorkspaceSessionState,
  tabId: string
): TerminalTabViewMode | undefined {
  for (const [worktreeId, rows] of Object.entries(session.tabsByWorktree)) {
    const row = rows.find((tab) => tab.id === tabId)
    if (row) {
      const unified = session.unifiedTabs?.[worktreeId]?.find(
        (tab) => tab.contentType === 'terminal' && tab.entityId === tabId
      )
      return resolveTerminalTabViewMode(unified, row)
    }
  }
  return undefined
}
