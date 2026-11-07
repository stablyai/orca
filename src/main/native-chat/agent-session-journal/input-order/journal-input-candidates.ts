import { orchestrationMailNotice } from '../../../../shared/agent-session/agent-session-message-source'
import type { QueuedMessageRow } from '../queued-messages/queued-message-table'

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

/** The live cards that could lead the queue (waiting and not held, or returned), kept in queue order as
 *  each one changes: what a pass over held mail walks, never the epoch's dispatched or withdrawn history. */
export class JournalInputCandidates {
  private readonly byId = new Map<string, QueuedMessageRow>()
  private root: Node | undefined
  private mailCount = 0
  /** Changes with any candidate, so a walk's answer is reused only while none has. */
  private revision = 0
  private walked: { head: QueuedMessageRow; key: string; next: QueuedMessageRow | null }[] = []

  set(card: QueuedMessageRow, candidate: boolean): void {
    const prior = this.byId.get(card.messageId)
    if ((prior === card && candidate) || (!prior && !candidate)) {
      return
    }
    if (prior) {
      this.mailCount -= orchestrationMailNotice(prior.body.from) ? 1 : 0
      this.root = put(this.root, prior, true)
      this.byId.delete(card.messageId)
    }
    if (candidate) {
      this.mailCount += orchestrationMailNotice(card.body.from) ? 1 : 0
      this.root = put(this.root, card, false)
      this.byId.set(card.messageId, card)
    }
    this.revision += 1
  }

  clear(): void {
    this.byId.clear()
    this.root = undefined
    this.mailCount = 0
    this.revision += 1
  }

  hasMail(): boolean {
    return this.mailCount > 0
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
    walk: () => QueuedMessageRow | null
  ): QueuedMessageRow | null {
    const key = [this.revision, ...inputs].join(':')
    const hit = this.walked.find((entry) => entry.head === head && entry.key === key)
    if (hit) {
      return hit.next
    }
    const next = walk()
    this.walked = [...this.walked, { head, key, next }].slice(-3)
    return next
  }
}
