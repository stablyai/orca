import type { AgentJournalRenderItem } from '../../../../shared/agent-session/journal/agent-session-journal-types'
import { compareAgentJournalItems } from '../../../../shared/agent-session/journal/agent-session-journal-position'
import { putOrdered, type OrderedTree } from './journal-ordered-tree'

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
  value: TurnSource
  height: number
  left?: TurnSourceNode
  right?: TurnSourceNode
  latest: TurnSource
  anchor: TurnSource | undefined
  winner: TurnSource | undefined
}

export const compareTurnSources = (a: TurnSource, b: TurnSource): number =>
  compareAgentJournalItems(a.item, b.item) || a.item.itemId.localeCompare(b.item.itemId)

const turnSources: OrderedTree<TurnSource, TurnSourceNode> = {
  compare: compareTurnSources,
  create: (value) => ({ value, height: 1, latest: value, anchor: undefined, winner: undefined }),
  refresh: (node) => {
    const { value: source, left, right } = node
    node.latest = right?.latest ?? source
    node.anchor = right?.anchor ?? (source.ordinary ? source : left?.anchor)
    node.winner = right?.winner ?? (source.relevant ? source : left?.winner)
  }
}

/** Inserts, replaces (same position) or removes one source along a single root-to-leaf path. */
export function putTurnSource(
  node: TurnSourceNode | undefined,
  source: TurnSource,
  remove: boolean
): TurnSourceNode | undefined {
  return putOrdered(turnSources, node, source, remove)
}
