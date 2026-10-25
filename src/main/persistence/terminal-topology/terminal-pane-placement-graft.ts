import type { TerminalPanePlacement } from '../../../shared/terminal-pane-placement'
import type { TerminalPaneLayoutNode } from '../../../shared/terminal-tab-types'
import {
  collectLayoutLeafIdsInOrder,
  insertLeafBeside,
  layoutContainsLeafId,
  removeLayoutLeaf,
  samePanesIgnoringRatios
} from '../../../shared/workspace-layout/terminal-pane-tree'
import { cloneLayoutNode } from '../restoring-sessions/terminal-layout-normalization'

/**
 * Where a split's new pane joins a tree that lacks it: as the window's tree places it when that
 * tree is this one plus only the pane (the one way to say "before" or split a group of panes),
 * else beside the parent pane. Null when the spawn names no split or a parent this tree lacks.
 */
export function placedSplitRoot(
  root: TerminalPaneLayoutNode,
  leafId: string,
  placement: TerminalPanePlacement | undefined
): TerminalPaneLayoutNode | null {
  if (placement?.kind !== 'split' || !layoutContainsLeafId(root, placement.parentLeafId)) {
    return null
  }
  const { proposedRoot, parentLeafId, direction, ratio } = placement
  if (proposedRoot && addsOnlyLeaf(root, proposedRoot, leafId)) {
    return withNewSplit(proposedRoot, root, leafId)
  }
  return insertLeafBeside(
    cloneLayoutNode(root),
    parentLeafId,
    leafId,
    direction === 'vertical' ? 'right' : 'bottom',
    ratio
  )
}

function addsOnlyLeaf(
  root: TerminalPaneLayoutNode,
  proposed: TerminalPaneLayoutNode,
  leafId: string
): boolean {
  const without = removeLayoutLeaf(proposed, leafId)
  return (
    collectLayoutLeafIdsInOrder(proposed).filter((id) => id === leafId).length === 1 &&
    without !== null &&
    samePanesIgnoringRatios(without, root)
  )
}

/** Main's tree with only the window's new split taken; main's own divider positions stay. */
function withNewSplit(
  proposed: TerminalPaneLayoutNode,
  root: TerminalPaneLayoutNode,
  leafId: string
): TerminalPaneLayoutNode {
  if (proposed.type === 'leaf') {
    return cloneLayoutNode(root)
  }
  const isNew = (node: TerminalPaneLayoutNode): boolean =>
    node.type === 'leaf' && node.leafId === leafId
  if (isNew(proposed.first) || isNew(proposed.second)) {
    return {
      ...proposed,
      first: isNew(proposed.first) ? cloneLayoutNode(proposed.first) : cloneLayoutNode(root),
      second: isNew(proposed.second) ? cloneLayoutNode(proposed.second) : cloneLayoutNode(root)
    }
  }
  // addsOnlyLeaf proved `root` is this split, with the new pane inside one side.
  if (root.type === 'leaf') {
    return cloneLayoutNode(root)
  }
  return {
    ...root,
    first: withNewSplit(proposed.first, root.first, leafId),
    second: withNewSplit(proposed.second, root.second, leafId)
  }
}
