import type { AgentJournalCursor } from '../../../../shared/agent-session/journal/agent-session-journal-identity'
import type { QueuedMessageRow } from '../queued-messages/queued-message-table'

export type InputPlaceQuery = {
  head?: QueuedMessageRow
  command?: QueuedMessageRow
  waiting?: QueuedMessageRow
  handoff?: QueuedMessageRow
  position: number
}
export type JournalInputPlaceEntry = InputPlaceQuery & {
  id: string
  sequence: number
  domain: string | undefined
  tie?: number
}
type Node = {
  entry: JournalInputPlaceEntry
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
const compare = (a: JournalInputPlaceEntry, b: JournalInputPlaceEntry) =>
  a.sequence - b.sequence || (a.tie ?? 0) - (b.tie ?? 0) || a.id.localeCompare(b.id)
function update(node: Node): Node {
  node.height = 1 + Math.max(height(node.left), height(node.right))
  node.result = mergeInputPlaces(
    mergeInputPlaces(node.left?.result ?? empty(), node.entry),
    node.right?.result ?? empty()
  )
  return node
}
function left(node: Node): Node {
  node = { ...node }
  const next = { ...node.right! }
  node.right = next.left
  next.left = update(node)
  return update(next)
}
function right(node: Node): Node {
  node = { ...node }
  const next = { ...node.left! }
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
function put(
  node: Node | undefined,
  entry: JournalInputPlaceEntry,
  remove: boolean
): Node | undefined {
  if (!node) {
    return remove ? undefined : { entry, height: 1, result: entry }
  }
  node = { ...node }
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
  private epochs = new Map<string, Node>()
  private all: Node | undefined
  private undomained = 0
  private entries = new Map<string, JournalInputPlaceEntry>()

  constructor(_epoch: string) {}

  /** An actual open's export reads the entries as restore left them. */
  exportEntries(): IterableIterator<JournalInputPlaceEntry> {
    return this.entries.values()
  }

  clear(): void {
    this.epochs = new Map()
    this.entries = new Map()
    this.all = undefined
    this.undomained = 0
  }

  set(
    card: QueuedMessageRow,
    actionable: boolean,
    handoff: boolean,
    coordinate: AgentJournalCursor | null = card.queuedAt
  ): void {
    this.delete(card.messageId)
    if (card.state === 'withdrawn') {
      return
    }
    const entry: JournalInputPlaceEntry = {
      id: card.messageId,
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

  /** Numeric summaries retain positions/sequences without retaining or walking record bodies. */
  setPosition(id: string, position: number, tie = 0, coordinate?: AgentJournalCursor): void {
    const prior = this.entries.get(id)
    const sequence = coordinate?.sequence ?? position
    const domain = coordinate?.epoch
    if (
      prior?.position === position &&
      prior.sequence === sequence &&
      prior.domain === domain &&
      (prior.tie ?? 0) === tie
    ) {
      return
    }
    this.delete(id)
    const entry: JournalInputPlaceEntry = { id, sequence, domain, position, tie }
    this.entries.set(id, entry)
    this.change(entry, false)
  }

  delete(id: string): void {
    const prior = this.entries.get(id)
    if (prior) {
      this.change(prior, true)
      this.entries.delete(id)
    }
  }

  private change(entry: JournalInputPlaceEntry, remove: boolean): void {
    const epoch = entry.domain
    if (epoch !== undefined) {
      const root = put(this.epochs.get(epoch), entry, remove)
      if (root) {
        this.epochs.set(epoch, root)
      } else {
        this.epochs.delete(epoch)
      }
      if (root && this.epochs.size === 1 && this.undomained === 0) {
        this.all = root
        return
      }
    } else {
      this.undomained += remove ? -1 : 1
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

  lastId(): string | undefined {
    let node = this.all
    while (node?.right) {
      node = node.right
    }
    return node?.entry.id
  }

  successorId(sequence: number): string | undefined {
    let node = this.all,
      selected: string | undefined
    while (node) {
      if (node.entry.sequence > sequence) {
        selected = node.entry.id
        node = node.left
      } else {
        node = node.right
      }
    }
    return selected
  }

  idsAfter(sequence: number): string[] {
    const ids: string[] = []
    const visit = (node?: Node): void => {
      if (!node) {
        return
      }
      if (node.entry.sequence > sequence) {
        visit(node.left)
        ids.push(node.entry.id)
      }
      visit(node.right)
    }
    visit(this.all)
    return ids
  }

  firstPosition(): number {
    let node = this.all
    while (node?.left) {
      node = node.left
    }
    return node?.entry.position ?? Infinity
  }

  allPlaces(): InputPlaceQuery {
    return this.all?.result ?? empty()
  }
}
