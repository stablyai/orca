import type { AgentJournalCursor } from '../../../shared/agent-session-journal-types'
import type { QueuedMessageRow } from './queued-message-table'

export type InputPlaceQuery = {
  head?: QueuedMessageRow
  command?: QueuedMessageRow
  waiting?: QueuedMessageRow
  handoff?: QueuedMessageRow
  position: number
}
type Entry = InputPlaceQuery & { card: QueuedMessageRow; sequence: number; domain: string }
type Node = {
  entry: Entry
  height: number
  result: InputPlaceQuery
  left?: Node
  right?: Node
}
const empty = (): InputPlaceQuery => ({ position: -Infinity })
const first = (a?: QueuedMessageRow, b?: QueuedMessageRow) =>
  !a || (b && b.position < a.position) ? b : a
export function mergeInputPlaces(a: InputPlaceQuery, b: InputPlaceQuery): InputPlaceQuery {
  return {
    head: first(a.head, b.head),
    command: first(a.command, b.command),
    waiting: first(a.waiting, b.waiting),
    handoff: first(a.handoff, b.handoff),
    position: Math.max(a.position, b.position)
  }
}
const height = (node?: Node) => node?.height ?? 0
const compare = (a: Entry, b: Entry) =>
  a.sequence - b.sequence || a.card.messageId.localeCompare(b.card.messageId)
function update(node: Node): Node {
  node.height = 1 + Math.max(height(node.left), height(node.right))
  node.result = mergeInputPlaces(
    mergeInputPlaces(node.left?.result ?? empty(), node.entry),
    node.right?.result ?? empty()
  )
  return node
}
function left(node: Node): Node {
  const next = node.right!
  node.right = next.left
  next.left = update(node)
  return update(next)
}
function right(node: Node): Node {
  const next = node.left!
  node.left = next.right
  next.right = update(node)
  return update(next)
}
function balance(node: Node): Node {
  update(node)
  if (height(node.left) - height(node.right) > 1) {
    if (height(node.left!.right) > height(node.left!.left)) {
      node.left = left(node.left!)
    }
    return right(node)
  }
  if (height(node.right) - height(node.left) > 1) {
    if (height(node.right!.left) > height(node.right!.right)) {
      node.right = right(node.right!)
    }
    return left(node)
  }
  return node
}
function put(node: Node | undefined, entry: Entry, remove: boolean): Node | undefined {
  if (!node) {
    return remove ? undefined : { entry, height: 1, result: entry }
  }
  const order = compare(entry, node.entry)
  if (order < 0) {
    node.left = put(node.left, entry, remove)
  } else if (order > 0) {
    node.right = put(node.right, entry, remove)
  } else if (!remove) {
    node.entry = entry
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
    node.entry = next.entry
    node.right = put(node.right, next.entry, true)
  }
  return balance(node)
}

/** Current card coordinates only; subtree summaries answer admission/selection/recovery cuts. */
export class JournalInputPlaceIndex {
  private readonly epochs = new Map<string, Node>()
  private all: Node | undefined
  private readonly entries = new Map<string, Entry>()

  constructor(_epoch: string) {}

  set(
    card: QueuedMessageRow,
    actionable: boolean,
    handoff: boolean,
    coordinate: AgentJournalCursor | null = card.queuedAt
  ): void {
    const prior = this.entries.get(card.messageId)
    if (prior) {
      this.change(prior, true)
    }
    this.entries.delete(card.messageId)
    if (card.state === 'withdrawn') {
      return
    }
    const entry: Entry = {
      card,
      sequence: coordinate?.sequence ?? 0,
      domain: coordinate?.epoch ?? '',
      position: card.position,
      ...((card.state === 'waiting' && card.holdReason === null) || card.state === 'returned'
        ? { head: card }
        : {}),
      ...(actionable ? { waiting: card, ...(card.body.command ? { command: card } : {}) } : {}),
      ...(handoff ? { handoff: card } : {})
    }
    this.entries.set(card.messageId, entry)
    this.change(entry, false)
  }

  private change(entry: Entry, remove: boolean): void {
    const epoch = entry.domain
    const root = put(this.epochs.get(epoch), entry, remove)
    if (root) {
      this.epochs.set(epoch, root)
    } else {
      this.epochs.delete(epoch)
    }
    this.all = put(this.all, entry, remove)
  }

  isEmpty(): boolean {
    return this.entries.size === 0
  }

  query(epoch: string, sequence = Infinity): InputPlaceQuery {
    const before = (node?: Node): InputPlaceQuery => {
      if (!node) {
        return empty()
      }
      if (node.entry.sequence >= sequence) {
        return before(node.left)
      }
      return mergeInputPlaces(
        mergeInputPlaces(node.left?.result ?? empty(), node.entry),
        before(node.right)
      )
    }
    return before(this.epochs.get(epoch))
  }

  allPlaces(): InputPlaceQuery {
    return this.all?.result ?? empty()
  }
}
