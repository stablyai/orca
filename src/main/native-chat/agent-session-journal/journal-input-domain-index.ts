import {
  queryInputContext,
  type JournalInputCard,
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

/** A fixed-width introduction prefix, with coordinate summaries on each of its 53 levels. */
export class JournalInputDomainIndex {
  private readonly root: Node = { index: new JournalInputPlaceIndex('') }

  set(
    card: QueuedMessageRow,
    source: JournalInputCard,
    actionable: boolean,
    handoff: boolean
  ): void {
    if (!source.baseline) {
      return
    }
    let node = this.root,
      low = 0,
      high = LIMIT
    while (true) {
      node.index.set(card, actionable, handoff, source.baseline.coordinate)
      if (high - low <= 1) {
        break
      }
      const mid = low + Math.floor((high - low) / 2)
      if (source.introduced < mid) {
        node = node.left ??= { index: new JournalInputPlaceIndex('') }
        high = mid
      } else {
        node = node.right ??= { index: new JournalInputPlaceIndex('') }
        low = mid
      }
    }
  }

  query(context: JournalInputContext, original?: AgentJournalCursor): InputPlaceQuery {
    let result: InputPlaceQuery = { position: -Infinity }
    const append = (node: Node) => {
      result = mergeInputPlaces(
        result,
        queryInputContext(
          context,
          original,
          (coordinate) => node.index.query(coordinate.epoch, coordinate.sequence),
          () => node.index.allPlaces(),
          mergeInputPlaces
        )
      )
    }
    let node: Node | undefined = this.root,
      low = 0,
      high = LIMIT
    while (node && low < context.cut) {
      if (high <= context.cut) {
        append(node)
        break
      }
      const mid = low + Math.floor((high - low) / 2)
      if (context.cut <= mid) {
        node = node.left
        high = mid
      } else {
        if (node.left) {
          append(node.left)
        }
        node = node.right
        low = mid
      }
    }
    return result
  }
}
