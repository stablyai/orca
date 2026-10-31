import {
  queryInputContext,
  type JournalCardAlias,
  type JournalInputContext
} from './journal-input-lineage'
import {
  JournalInputPlaceIndex,
  mergeInputPlaces,
  type InputPlaceQuery
} from './journal-input-place-index'
import type { QueuedMessageRow } from './queued-message-table'
import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'

type Node = { index: JournalInputPlaceIndex; left?: Node; right?: Node }
const LIMIT = Number.MAX_SAFE_INTEGER

/** Interval decomposition shares alias domains; a cut visits one logarithmic root-to-leaf path. */
export class JournalInputDomainIndex {
  private readonly root: Node = { index: new JournalInputPlaceIndex('') }

  set(
    card: QueuedMessageRow,
    alias: JournalCardAlias,
    actionable: boolean,
    handoff: boolean,
    remove = false
  ): void {
    const update = (node: Node, low: number, high: number): void => {
      if (alias.from >= high || (alias.until ?? LIMIT) <= low) {
        return
      }
      if (alias.from <= low && (alias.until ?? LIMIT) >= high) {
        node.index.set(
          remove ? { ...card, state: 'withdrawn' } : card,
          actionable,
          handoff,
          alias.coordinate
        )
        return
      }
      const mid = low + Math.floor((high - low) / 2)
      if (alias.from < mid) {
        update((node.left ??= { index: new JournalInputPlaceIndex('') }), low, mid)
      }
      if ((alias.until ?? LIMIT) > mid) {
        update((node.right ??= { index: new JournalInputPlaceIndex('') }), mid, high)
      }
      if (node.left?.index.isEmpty() && !node.left.left && !node.left.right) {
        delete node.left
      }
      if (node.right?.index.isEmpty() && !node.right.left && !node.right.right) {
        delete node.right
      }
    }
    if (alias.present) {
      update(this.root, 0, LIMIT)
    }
  }

  query(context: JournalInputContext, original?: AgentJournalCursor): InputPlaceQuery {
    let result: InputPlaceQuery = { position: -Infinity }
    let node: Node | undefined = this.root
    let low = 0,
      high = LIMIT
    while (node) {
      const at = queryInputContext(
        context,
        original,
        (coordinate) => node!.index.query(coordinate.epoch, coordinate.sequence),
        () => node!.index.allPlaces(),
        mergeInputPlaces
      )
      result = mergeInputPlaces(result, at)
      const mid = low + Math.floor((high - low) / 2)
      if (context.cut < mid) {
        node = node.left
        high = mid
      } else {
        node = node.right
        low = mid
      }
    }
    return result
  }
}
