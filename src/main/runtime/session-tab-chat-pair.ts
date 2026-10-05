import type { RuntimeSessionTabChatView } from '../../shared/runtime-session-contracts'
import type { RuntimeMobileSessionTabsSnapshot } from '../../shared/runtime-types'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../shared/terminal-tab-types'
import {
  normalizeTerminalChatPair,
  pinTerminalChatOwnerOnGrowth,
  resolveTerminalTabViewMode,
  type TerminalChatPair
} from '../../shared/terminal-tab-view-mode'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  terminalLayoutNodeContainsLeaf,
  terminalLayoutNodeLeafIds
} from '../../shared/native-chat-leaf-ownership'
import { pickChatOwnerLeaf } from '../../shared/native-chat-owner-pick'

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
  layout: TerminalLayoutSnapshot | undefined
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
      hasLayout: Boolean(layout),
      layout
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
    hasLayout: Boolean(layout),
    layout
  }
}

/** The host's owner for a chat with none, from the launch record of each pane's bound PTY. */
export function pickSessionTabChatOwner(
  layout: TerminalLayoutSnapshot | undefined,
  launchAgentForPty: (ptyId: string) => string | null | undefined
): string | null {
  return pickChatOwnerLeaf({
    leafIds: terminalLayoutNodeLeafIds(layout?.root),
    activeLeafId: layout?.activeLeafId,
    leafLaunchAgent: (leafId) => {
      const ptyId = layout?.ptyIdsByLeafId?.[leafId]
      return ptyId ? launchAgentForPty(ptyId) : null
    }
  })
}

/**
 * The repair's owner from complete evidence only: undefined while any pane has no bound PTY whose
 * launch identity is known (`knownLaunchAgentForPty` returns undefined), since unknown is not "none".
 */
export function pickSessionTabChatOwnerFromKnownEvidence(
  layout: TerminalLayoutSnapshot,
  knownLaunchAgentForPty: (ptyId: string) => string | null | undefined
): string | null | undefined {
  const complete = terminalLayoutNodeLeafIds(layout.root).every((leafId) => {
    const ptyId = layout.ptyIdsByLeafId?.[leafId]
    return ptyId !== undefined && knownLaunchAgentForPty(ptyId) !== undefined
  })
  return complete ? pickSessionTabChatOwner(layout, knownLaunchAgentForPty) : undefined
}

export function toSessionTabChatView(
  state: HeadlessChatPairState | null
): RuntimeSessionTabChatView {
  const pair = state ? normalizeTerminalChatPair(state.pair, state.root) : {}
  return { viewMode: pair.viewMode ?? null, chatLeafId: pair.chatLeafId ?? null }
}

/**
 * The owner a layout push may write: a push that grows an ownerless single-pane chat pins that
 * pane; otherwise only a chat tab with no valid owner accepts the client's owner, and only for a
 * leaf in the pushed tree. Undefined leaves the stored owner untouched.
 */
export function resolvePaneLayoutChatOwnerFillIn(
  state: HeadlessChatPairState | null,
  incomingRoot: TerminalPaneLayoutNode | null,
  chatLeafId: string | null | undefined
): string | undefined {
  const pinned = pinTerminalChatOwnerOnGrowth({
    viewMode: state?.pair.viewMode,
    chatLeafId: state?.pair.chatLeafId,
    priorRoot: state?.root,
    nextRoot: incomingRoot
  })
  if (pinned && pinned !== state?.pair.chatLeafId) {
    return pinned
  }
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
