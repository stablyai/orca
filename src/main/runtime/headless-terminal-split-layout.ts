import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode
} from '../../shared/terminal-tab-types'
import {
  insertLeafBeside,
  removeLayoutLeaf
} from '../../shared/workspace-layout/terminal-pane-tree'

/** Persist headless splits so snapshot rebuilds cannot collapse them to a stale single pane. */
export function buildHeadlessTerminalSplitLayout(
  existing: TerminalLayoutSnapshot | undefined,
  args: {
    leafId: string
    ptyId: string
    splitFromLeafId: string
    direction: 'horizontal' | 'vertical'
  }
): TerminalLayoutSnapshot {
  // Remove an existing copy before replacing the leaf beside its source.
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

export function countTerminalLayoutLeaves(node: TerminalPaneLayoutNode | null | undefined): number {
  if (!node) {
    return 0
  }
  if (node.type === 'leaf') {
    return 1
  }
  return countTerminalLayoutLeaves(node.first) + countTerminalLayoutLeaves(node.second)
}
