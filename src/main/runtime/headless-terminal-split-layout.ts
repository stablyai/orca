import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../shared/terminal-tab-types'
import {
  insertLeafBeside,
  removeLayoutLeaf
} from '../../shared/workspace-layout/terminal-pane-tree'

/**
 * Insert a newly split-off leaf into a terminal tab's persisted layout tree.
 *
 * Why: a headless ("Orca server") split only updated the live session snapshot,
 * never the persisted workspace-session layout, so a later snapshot rebuild
 * re-derived from the stale single-leaf layout and collapsed the split. This
 * builds the durable post-split layout so the split survives rebuilds.
 */
export function buildHeadlessTerminalSplitLayout(
  existing: TerminalLayoutSnapshot | undefined,
  args: {
    leafId: string
    ptyId: string
    splitFromLeafId: string
    direction: 'horizontal' | 'vertical'
  }
): TerminalLayoutSnapshot {
  // Why: the stored tree may already hold the new leaf; it is placed again beside its source.
  const currentRoot = existing?.root ? removeLayoutLeaf(existing.root, args.leafId) : null
  const existingRoot: TerminalPaneLayoutNode = currentRoot ?? {
    type: 'leaf',
    leafId: args.splitFromLeafId
  }
  const ptyIdsByLeafId = { ...existing?.ptyIdsByLeafId }
  delete ptyIdsByLeafId[args.leafId]
  return {
    ...existing,
    root: insertLeafBeside(
      existingRoot,
      args.splitFromLeafId,
      args.leafId,
      args.direction === 'vertical' ? 'right' : 'bottom'
    ),
    activeLeafId: args.leafId,
    expandedLeafId: existing?.expandedLeafId ?? null,
    ptyIdsByLeafId: {
      ...ptyIdsByLeafId,
      [args.leafId]: args.ptyId
    }
  }
}

/** Count the leaves in a layout tree (a split has ≥2; a single pane has 1). */
export function countTerminalLayoutLeaves(node: TerminalPaneLayoutNode | null | undefined): number {
  if (!node) {
    return 0
  }
  if (node.type === 'leaf') {
    return 1
  }
  return countTerminalLayoutLeaves(node.first) + countTerminalLayoutLeaves(node.second)
}
