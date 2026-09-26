import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../shared/terminal-tab-types'
import type { TerminalSurfaceCloseTarget } from '../../shared/terminal-surface-close-target'
import {
  closeTerminalTabInWorkspaceSession,
  type WorkspaceSessionTerminalTabCloseResult
} from '../../shared/workspace-session-terminal-tab-close'
import { retireTerminalSurfaceFromPersistence } from './mobile-session-terminal-persistence-retirement'
import { advanceTerminalTopologyRevision } from './workspace-session-terminal-membership-authority'

/** Where a pane close lands: its own removal, its tab's last pane, or a pane the copy lacks. */
export type PaneCloseResolution = 'pane' | 'last-pane' | 'absent'

export function collectTerminalLayoutLeafIds(
  node: TerminalPaneLayoutNode | null | undefined
): string[] {
  if (!node) {
    return []
  }
  if (node.type === 'leaf') {
    return [node.leafId]
  }
  return [...collectTerminalLayoutLeafIds(node.first), ...collectTerminalLayoutLeafIds(node.second)]
}

/**
 * Resolves a pane close against the panes one copy records. Only a copy that positively shows this
 * pane as its tab's one pane widens the close; a copy recording no panes knows nothing about it.
 */
export function resolvePaneClose(
  leafIds: readonly string[] | null,
  leafId: string
): PaneCloseResolution {
  if (!leafIds?.includes(leafId)) {
    return 'absent'
  }
  return leafIds.length === 1 ? 'last-pane' : 'pane'
}

/** Every copy of a tab's panes main can read when it resolves a close it started. */
export type TerminalCloseLayoutCopies = {
  /** The desktop renderer lists the tab, so it owns the tab's panes. */
  rendererListsTab: boolean
  /** The tab's rows in the published session snapshot. */
  snapshotRows: readonly { leafId: string; parentLayout?: TerminalLayoutSnapshot }[]
  /** The tab's panes in the renderer-published runtime graph. */
  graphLeafIds: readonly string[]
  sessionLayout: TerminalLayoutSnapshot | undefined
}

/** Reads the panes from whoever owns the tab's layout; `null` means no copy records any. */
function readLayoutOwnerLeafIds(copies: TerminalCloseLayoutCopies): readonly string[] | null {
  const published =
    copies.snapshotRows
      .map((row) => collectTerminalLayoutLeafIds(row.parentLayout?.root))
      .find((leafIds) => leafIds.length > 0) ?? []
  const rows = copies.snapshotRows.map((row) => row.leafId)
  // Why: main's saved layout lacks a renderer split whose PTY binding has not committed yet;
  // the published layout outranks the graph, which relay recovery can leave with stale panes.
  const ownerCopies = copies.rendererListsTab
    ? [published, copies.graphLeafIds, rows]
    : [collectTerminalLayoutLeafIds(copies.sessionLayout?.root), published, rows]
  // Why: a layout saved before its pane mounted (or a graph before its panes register) is empty.
  return ownerCopies.find((leafIds) => leafIds.length > 0) ?? null
}

/**
 * The only place main turns a pane close into its tab's close: `last-pane` sends callers down
 * the tab path (and its renderer pin guard); anything else closes that pane or nothing.
 * D1 (main as the single layout writer) collapses the owner read to main's session layout alone.
 */
export function resolveTerminalCloseTarget(
  target: TerminalSurfaceCloseTarget,
  copies: TerminalCloseLayoutCopies
): PaneCloseResolution | 'tab' {
  return target.kind === 'tab'
    ? 'tab'
    : resolvePaneClose(readLayoutOwnerLeafIds(copies), target.leafId)
}

export type TerminalSurfaceCloseResult = WorkspaceSessionTerminalTabCloseResult & {
  resolution: PaneCloseResolution | 'tab'
}

/**
 * The membership half of every explicit terminal close: removes a tab, or one pane of a split
 * tab, and advances the repo's topology revision so a stale renderer save cannot restore it.
 * A pane close only ever removes that pane; the resolution says why anything else was a no-op.
 */
export function closeTerminalSurfaceInWorkspaceSession(
  session: WorkspaceSessionState,
  worktreeId: string,
  target: TerminalSurfaceCloseTarget,
  options: { force?: boolean } = {}
): TerminalSurfaceCloseResult {
  if (target.kind === 'pane') {
    const layout = session.terminalLayoutsByTabId[target.tabId]
    const resolution = resolvePaneClose(
      layout ? collectTerminalLayoutLeafIds(layout.root) : null,
      target.leafId
    )
    // Why: the exit may already have retired this pane, leaving only live siblings to lose.
    if (!layout || resolution !== 'pane') {
      return { session, ptyIdsToKill: [], closed: false, pinned: false, resolution }
    }
    // The pane's own binding is passed so the retirement's stale-binding fence always admits it.
    const retired = retireTerminalSurfaceFromPersistence(session, {
      worktreeId,
      parentTabId: target.tabId,
      leafId: target.leafId,
      ptyId: layout.ptyIdsByLeafId?.[target.leafId] ?? ''
    })
    return { session: retired, ptyIdsToKill: [], closed: true, pinned: false, resolution }
  }
  const result = closeTerminalTabInWorkspaceSession(session, worktreeId, target.tabId, {
    force: options.force
  })
  return {
    ...result,
    ...(result.closed
      ? { session: advanceTerminalTopologyRevision(result.session, worktreeId) }
      : {}),
    resolution: 'tab'
  }
}
