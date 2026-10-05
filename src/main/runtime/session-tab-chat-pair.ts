import type { RuntimeSessionTabChatView } from '../../shared/runtime-session-contracts'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type { TerminalPaneLayoutNode } from '../../shared/terminal-tab-types'
import {
  normalizeTerminalChatPair,
  resolveTerminalTabViewMode,
  type TerminalChatPair
} from '../../shared/terminal-tab-view-mode'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import { terminalLayoutNodeContainsLeaf } from '../../shared/native-chat-leaf-ownership'

/** Resolves a `setTabProps` id to its parent tab and, for a leaf surface id, that leaf. */
export function resolveSessionTabChatPairTarget(
  snapshot: RuntimeMobileSessionTabsSnapshot | undefined,
  tabId: string,
  parentTabId: string
): { parentTabId: string; leafId: string | null } {
  const surface = snapshot?.tabs.find(
    (candidate) => candidate.type === 'terminal' && candidate.id === tabId
  )
  if (surface?.type === 'terminal' && surface.id !== surface.parentTabId) {
    return { parentTabId: surface.parentTabId, leafId: surface.leafId }
  }
  // Why: a leaf the snapshot no longer lists still names its parent; the write then changes nothing.
  const separator = parentTabId === tabId ? tabId.indexOf('::') : -1
  return separator > 0
    ? { parentTabId: tabId.slice(0, separator), leafId: tabId.slice(separator + 2) }
    : { parentTabId, leafId: null }
}

export type HeadlessChatPairState = {
  pair: TerminalChatPair
  root: TerminalPaneLayoutNode | null | undefined
  hasLayout: boolean
}

/** The persisted pair of a headless tab, or its published row when persistence lacks it. */
export function readHeadlessChatPairState(
  session: WorkspaceSessionState | null | undefined,
  snapshot: RuntimeMobileSessionTabsSnapshot | undefined,
  worktreeId: string,
  parentTabId: string
): HeadlessChatPairState | null {
  const row = session?.tabsByWorktree[worktreeId]?.find((tab) => tab.id === parentTabId)
  if (row) {
    const unified = session?.unifiedTabs?.[worktreeId]?.find(
      (tab) => tab.id === parentTabId || tab.entityId === parentTabId
    )
    const layout = session?.terminalLayoutsByTabId?.[parentTabId]
    const viewMode = resolveTerminalTabViewMode(unified, row)
    return {
      pair: {
        ...(viewMode ? { viewMode } : {}),
        ...(layout?.chatLeafId ? { chatLeafId: layout.chatLeafId } : {})
      },
      root: layout?.root,
      hasLayout: Boolean(layout)
    }
  }
  return readPublishedChatPairState(snapshot, parentTabId)
}

export function readPublishedChatPairState(
  snapshot: RuntimeMobileSessionTabsSnapshot | undefined,
  parentTabId: string
): HeadlessChatPairState | null {
  const surface = snapshot?.tabs.find(
    (candidate) => candidate.type === 'terminal' && candidate.parentTabId === parentTabId
  )
  if (surface?.type !== 'terminal') {
    return null
  }
  const layout = surface.parentLayout
  return {
    pair: {
      ...(surface.viewMode ? { viewMode: surface.viewMode } : {}),
      ...(layout?.chatLeafId ? { chatLeafId: layout.chatLeafId } : {})
    },
    root: layout?.root,
    hasLayout: Boolean(layout)
  }
}

export function toSessionTabChatView(
  state: HeadlessChatPairState | null
): RuntimeSessionTabChatView {
  const pair = state ? normalizeTerminalChatPair(state.pair, state.root) : {}
  return { viewMode: pair.viewMode ?? null, chatLeafId: pair.chatLeafId ?? null }
}

/**
 * The owner a layout push may write: only a chat tab with no valid owner accepts one, and only
 * for a leaf in the pushed tree. Undefined leaves the stored owner untouched.
 */
export function resolvePaneLayoutChatOwnerFillIn(
  state: HeadlessChatPairState | null,
  incomingRoot: TerminalPaneLayoutNode | null,
  chatLeafId: string | null | undefined
): string | undefined {
  if (!chatLeafId || state?.pair.viewMode !== 'chat') {
    return undefined
  }
  const owner = state.pair.chatLeafId
  if (owner && terminalLayoutNodeContainsLeaf(state.root, owner)) {
    return undefined
  }
  return terminalLayoutNodeContainsLeaf(incomingRoot ?? state.root, chatLeafId)
    ? chatLeafId
    : undefined
}
