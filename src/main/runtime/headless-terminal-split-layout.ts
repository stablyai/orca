import type { TerminalLayoutSnapshot, TerminalPaneLayoutNode } from '../../shared/types'

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
  const existingRoot: TerminalPaneLayoutNode = existing?.root ?? {
    type: 'leaf',
    leafId: args.splitFromLeafId
  }
  const insertSplit = (node: TerminalPaneLayoutNode): TerminalPaneLayoutNode => {
    if (node.type === 'leaf') {
      if (node.leafId !== args.splitFromLeafId) {
        return node
      }
      return {
        type: 'split',
        direction: args.direction,
        first: node,
        second: { type: 'leaf', leafId: args.leafId }
      }
    }
    return { ...node, first: insertSplit(node.first), second: insertSplit(node.second) }
  }
  return {
    ...existing,
    root: insertSplit(existingRoot),
    activeLeafId: args.leafId,
    expandedLeafId: existing?.expandedLeafId ?? null,
    ptyIdsByLeafId: {
      ...existing?.ptyIdsByLeafId,
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
