export type WorkerMessageShape = {
  kind: string
  /** Sum of the lengths of the arrays, maps and sets reached. */
  items: number
  /** Rough clone size: string lengths, buffer lengths, 8 per scalar. */
  bytes: number
  depth: number
  /** The walk stopped at its node budget, so the counts are lower bounds. */
  truncated: boolean
}

const NODE_BUDGET = 2048

/** Bounded and iterative, so a huge, deep or cyclic payload costs the sender at most the budget. */
export function describeWorkerMessage(message: unknown): WorkerMessageShape {
  let items = 0
  let bytes = 0
  let depth = 0
  let visited = 0
  let truncated = false
  const pending: [unknown, number][] = [[message, 1]]
  while (pending.length > 0) {
    if (visited >= NODE_BUDGET) {
      truncated = true
      break
    }
    visited += 1
    const [value, level] = pending.pop()!
    depth = Math.max(depth, level)
    if (typeof value === 'string') {
      bytes += value.length
      continue
    }
    if (value === null || typeof value !== 'object') {
      bytes += 8
      continue
    }
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      bytes += value.byteLength
      continue
    }
    const children: Iterable<unknown> =
      value instanceof Map || value instanceof Set
        ? value.values()
        : Array.isArray(value)
          ? value
          : objectValues(value as Record<string, unknown>, (key) => (bytes += key.length))
    if (Array.isArray(value)) {
      items += value.length
    } else if (value instanceof Map || value instanceof Set) {
      items += value.size
    }
    for (const child of children) {
      if (pending.length >= NODE_BUDGET) {
        truncated = true
        break
      }
      pending.push([child, level + 1])
    }
  }
  return { kind: messageKind(message), items, bytes, depth, truncated }
}

function* objectValues(
  value: Record<string, unknown>,
  onKey: (key: string) => void
): Generator<unknown> {
  for (const key in value) {
    onKey(key)
    yield value[key]
  }
}

function messageKind(message: unknown): string {
  if (message === null || typeof message !== 'object') {
    return typeof message
  }
  const record = message as Record<string, unknown>
  for (const field of ['type', 'kind', 'command', 'op']) {
    if (typeof record[field] === 'string') {
      return record[field]
    }
  }
  return 'object'
}
