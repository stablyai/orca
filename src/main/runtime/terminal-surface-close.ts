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
 * Resolves a pane close against one copy of its tab's panes. `null` means the copy has no record
 * of the tab; an empty list means it knows the tab but records no split, so it is one pane.
 */
export function resolvePaneClose(
  leafIds: readonly string[] | null,
  leafId: string
): PaneCloseResolution {
  if (!leafIds) {
    return 'absent'
  }
  if (leafIds.length === 0) {
    return 'last-pane'
  }
  if (!leafIds.includes(leafId)) {
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
  sessionListsTab: boolean
}

/** Reads the panes from whoever owns the tab's layout; `null` means no copy records the tab. */
function readLayoutOwnerLeafIds(copies: TerminalCloseLayoutCopies): string[] | null {
  const publishedLayout = copies.snapshotRows.find((row) => row.parentLayout)?.parentLayout
  const published = publishedLayout ? collectTerminalLayoutLeafIds(publishedLayout.root) : null
  if (copies.rendererListsTab) {
    // Why: main's saved layout lacks a renderer split whose PTY binding has not committed yet;
    // the published layout outranks the graph, which relay recovery can leave with stale panes.
    return published ?? [...copies.graphLeafIds]
  }
  if (copies.sessionLayout) {
    return collectTerminalLayoutLeafIds(copies.sessionLayout.root)
  }
  if (published) {
    return published
  }
  if (copies.snapshotRows.length > 0) {
    return copies.snapshotRows.map((row) => row.leafId)
  }
  return copies.sessionListsTab ? [] : null
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
