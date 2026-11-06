import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { compareAgentJournalItems } from '../../../shared/agent-session/journal/agent-session-journal-position'

/** A turn or context clear, with the row where it first became a holding failure (zero while it is
 * not one). A command that failed on its own terms is not `relevant`: it neither holds nor releases. */
export type TurnSource = {
  item: AgentJournalRenderItem
  failedAt: number
  /** Reconstruction proved this failure's native chronology through this removal frontier. */
  witnessedThrough?: number
  ordinary: boolean
  relevant: boolean
}
/** Creation-ordered; each subtree caches its newest source, ordinary turn or clear, and relevant source. */
export type TurnSourceNode = {
  source: TurnSource
  height: number
  latest: TurnSource
  anchor: TurnSource | undefined
  winner: TurnSource | undefined
  left?: TurnSourceNode
  right?: TurnSourceNode
}

export const compareTurnSources = (a: TurnSource, b: TurnSource): number =>
  compareAgentJournalItems(a.item, b.item) || a.item.itemId.localeCompare(b.item.itemId)
const height = (node?: TurnSourceNode) => node?.height ?? 0
function update(node: TurnSourceNode): TurnSourceNode {
  const { source, left, right } = node
  node.height = 1 + Math.max(height(left), height(right))
  node.latest = right?.latest ?? source
  node.anchor = right?.anchor ?? (source.ordinary ? source : left?.anchor)
  node.winner = right?.winner ?? (source.relevant ? source : left?.winner)
  return node
}
function rotateLeft(node: TurnSourceNode): TurnSourceNode {
  const next = node.right!
  node.right = next.left
  next.left = update(node)
  return update(next)
}
function rotateRight(node: TurnSourceNode): TurnSourceNode {
  const next = node.left!
  node.left = next.right
  next.right = update(node)
  return update(next)
}
function balance(node: TurnSourceNode): TurnSourceNode {
  update(node)
  if (height(node.left) - height(node.right) > 1) {
    if (height(node.left!.right) > height(node.left!.left)) {
      node.left = rotateLeft(node.left!)
    }
    return rotateRight(node)
  }
  if (height(node.right) - height(node.left) > 1) {
    if (height(node.right!.left) > height(node.right!.right)) {
      node.right = rotateRight(node.right!)
    }
    return rotateLeft(node)
  }
  return node
}

/** Inserts, replaces (same position) or removes one source along a single root-to-leaf path. */
export function putTurnSource(
  node: TurnSourceNode | undefined,
  source: TurnSource,
  remove: boolean
): TurnSourceNode | undefined {
  if (!node) {
    return remove
      ? undefined
      : update({ source, height: 1, latest: source, anchor: undefined, winner: undefined })
  }
  const order = compareTurnSources(source, node.source)
  if (order < 0) {
    node.left = putTurnSource(node.left, source, remove)
  } else if (order > 0) {
    node.right = putTurnSource(node.right, source, remove)
  } else if (!remove) {
    node.source = source
  } else {
    if (!node.left) {
      return node.right
    }
    if (!node.right) {
      return node.left
    }
    let next = node.right
    while (next.left) {
      next = next.left
    }
    node.source = next.source
    node.right = putTurnSource(node.right, next.source, true)
  }
  return balance(node)
}
