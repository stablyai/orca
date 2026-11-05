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
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'

export type JournalIndexedInputCard = {
  card: QueuedMessageRow
  actionable: boolean
  handoff: boolean
  source: JournalInputCard
  released: boolean
  releasedAt?: number
}

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
    this.change(card, source, actionable, handoff, false)
  }

  setPosition(card: QueuedMessageRow, source: JournalInputCard): void {
    this.change(card, source, false, false, card.state === 'withdrawn', true)
  }

  delete(card: QueuedMessageRow, source: JournalInputCard): void {
    this.change(card, source, false, false, true)
  }

  private change(
    card: QueuedMessageRow,
    source: JournalInputCard,
    actionable: boolean,
    handoff: boolean,
    remove: boolean,
    positionOnly = false
  ): void {
    if (!source.baseline) {
      return
    }
    let node = this.root,
      low = 0,
      high = LIMIT
    while (true) {
      if (remove) {
        node.index.delete(card.messageId)
      } else if (positionOnly) {
        node.index.setPosition(
          card.messageId,
          card.position,
          0,
          source.baseline.coordinate ?? { epoch: '', sequence: 0 }
        )
      } else {
        node.index.set(card, actionable, handoff, source.baseline.coordinate)
      }
      if (high - low <= 1) {
        break
      }
      const mid = low + Math.floor((high - low) / 2)
      if (source.introduced < mid) {
        if (remove && !node.left) {
          break
        }
        node = node.left ??= { index: new JournalInputPlaceIndex('') }
        high = mid
      } else {
        if (remove && !node.right) {
          break
        }
        node = node.right ??= { index: new JournalInputPlaceIndex('') }
        low = mid
      }
    }
  }

  query(context: JournalInputContext, original?: AgentJournalCursor): InputPlaceQuery {
    return this.before(context.cut, (index) =>
      queryInputContext(
        context,
        original,
        (coordinate) => index.query(coordinate.epoch, coordinate.sequence),
        () => index.allPlaces(),
        mergeInputPlaces
      )
    )
  }

  private before(
    cut: number,
    query: (index: JournalInputPlaceIndex) => InputPlaceQuery
  ): InputPlaceQuery {
    let result: InputPlaceQuery = { position: -Infinity }
    const append = (node: Node) => {
      result = mergeInputPlaces(result, query(node.index))
    }
    let node: Node | undefined = this.root,
      low = 0,
      high = LIMIT
    while (node && low < cut) {
      if (high <= cut) {
        append(node)
        break
      }
      const mid = low + Math.floor((high - low) / 2)
      if (cut <= mid) {
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
