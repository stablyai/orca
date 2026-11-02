import type { QueuedMessageRow } from './queued-message-table'

/** Queue order: position, then id, so two cards never compare equal. */
function precedes(a: QueuedMessageRow, b: QueuedMessageRow): boolean {
  return a.position < b.position || (a.position === b.position && a.messageId < b.messageId)
}

// A balanced tree, like the input place index: a write copies only the path it changes.
type Node = { card: QueuedMessageRow; height: number; left?: Node; right?: Node }
const height = (node?: Node) => node?.height ?? 0
function update(node: Node): Node {
  node.height = 1 + Math.max(height(node.left), height(node.right))
  return node
}
function rotateLeft(node: Node): Node {
  const next = node.right!
  node.right = next.left
  next.left = update(node)
  return update(next)
}
function rotateRight(node: Node): Node {
  const next = node.left!
  node.left = next.right
  next.right = update(node)
  return update(next)
}
function balance(node: Node): Node {
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
function put(node: Node | undefined, card: QueuedMessageRow, remove: boolean): Node | undefined {
  if (!node) {
    return remove ? undefined : { card, height: 1 }
  }
  if (precedes(card, node.card)) {
    node.left = put(node.left, card, remove)
  } else if (precedes(node.card, card)) {
    node.right = put(node.right, card, remove)
  } else if (!remove) {
    node.card = card
  } else {
    if (!node.left || !node.right) {
      return node.left ?? node.right
    }
    let next = node.right
    while (next.left) {
      next = next.left
    }
    node.card = next.card
    node.right = put(node.right, next.card, true)
  }
  return balance(node)
}

/** What a walk past the head found: the first card ready to go, and the first of those not mail. */
export type JournalPastHead = { first: QueuedMessageRow | null; person: QueuedMessageRow | null }

/** The live cards that could lead the queue (waiting and not held, or returned), kept in queue order as
 *  each one changes: what a pass over held mail walks, never the epoch's dispatched or withdrawn history. */
export class JournalInputCandidates {
  private readonly byId = new Map<string, QueuedMessageRow>()
  private root: Node | undefined
  /** Changes with any candidate, so a walk's answer is reused only while none has. */
  private revision = 0
  private walked: { head: QueuedMessageRow; key: string; next: JournalPastHead } | undefined

  set(card: QueuedMessageRow, candidate: boolean): void {
    const prior = this.byId.get(card.messageId)
    if ((prior === card && candidate) || (!prior && !candidate)) {
      return
    }
    if (prior) {
      this.root = put(this.root, prior, true)
      this.byId.delete(card.messageId)
    }
    if (candidate) {
      this.root = put(this.root, card, false)
      this.byId.set(card.messageId, card)
    }
    this.revision += 1
  }

  clear(): void {
    this.byId.clear()
    this.root = undefined
    this.revision += 1
  }

  /** Candidates behind `card` in queue order, one at a time: a walk stops at the first it needs. */
  *after(card: QueuedMessageRow): Generator<QueuedMessageRow> {
    const path: Node[] = []
    for (let node = this.root; node;) {
      if (node.card.position > card.position) {
        path.push(node)
        node = node.left
      } else {
        node = node.right
      }
    }
    while (path.length > 0) {
      const node = path.pop()!
      yield node.card
      for (let next = node.right; next; next = next.left) {
        path.push(next)
      }
    }
  }

  /** What the walk past `head` found, reused until a candidate or anything in `inputs` (the queue, its
   *  pauses, its edit holds) changes. The head's own mail authority is the caller's to ask every time:
   *  only structure is kept. */
  pastHead(
    head: QueuedMessageRow,
    inputs: readonly unknown[],
    walk: () => JournalPastHead
  ): JournalPastHead {
    const key = [this.revision, ...inputs].join(':')
    const last = this.walked
    if (last?.head === head && last.key === key) {
      return last.next
    }
    const next = walk()
    this.walked = { head, key, next }
    return next
  }
}
