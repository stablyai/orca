import type { QueuedMessageRow } from '../queued-messages/queued-message-table'

export function compareQueuedRows(a: QueuedMessageRow, b: QueuedMessageRow): number {
  return (
    a.position - b.position || (a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0)
  )
}
const precedes = (a: QueuedMessageRow, b: QueuedMessageRow) => compareQueuedRows(a, b) < 0

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

/** All current rows share one ordered index; point writes reach only the changed tree path. */
export class JournalQueuedRowIndex {
  private readonly byId = new Map<string, QueuedMessageRow>()
  private root: Node | undefined

  set(card: QueuedMessageRow, live: boolean): boolean {
    const prior = this.byId.get(card.messageId)
    if ((prior === card && live) || (!prior && !live)) {
      return false
    }
    if (prior && (!live || compareQueuedRows(prior, card) !== 0)) {
      this.root = put(this.root, prior, true)
    }
    if (live) {
      this.root = put(this.root, card, false)
      this.byId.set(card.messageId, card)
    } else {
      this.byId.delete(card.messageId)
    }
    return true
  }

  head(): QueuedMessageRow | undefined {
    let node = this.root
    while (node?.left) {
      node = node.left
    }
    return node?.card
  }

  *values(after?: QueuedMessageRow): Generator<QueuedMessageRow> {
    const path: Node[] = []
    for (let node = this.root; node;) {
      if (!after || compareQueuedRows(node.card, after) > 0) {
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
}
