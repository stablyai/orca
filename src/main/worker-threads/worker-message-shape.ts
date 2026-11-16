export type WorkerMessageShape = {
  kind: string
  /** Sum of the lengths of the arrays, maps and sets reached. */
  items: number
  /** Rough clone size: string lengths, buffer lengths, 8 per scalar; scaled up when truncated. */
  bytes: number
  depth: number
  /** The walk stopped at its node budget, so the counts are lower bounds. */
  truncated: boolean
}

const NODE_BUDGET = 2048
/** An object with more keys than this is a keyed collection (a Record of rows), not a struct. */
const RECORD_ENTRY_KEYS = 64

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
    let children: Iterable<unknown>
    if (value instanceof Map || value instanceof Set) {
      items += value.size
      children = value.values()
    } else if (Array.isArray(value)) {
      items += value.length
      truncated ||= value.length > NODE_BUDGET
      children = arrayDataValues(value)
    } else {
      const keys = Object.keys(value)
      if (keys.length > RECORD_ENTRY_KEYS) {
        items += keys.length
        truncated ||= keys.length > NODE_BUDGET
      }
      children = objectDataValues(value, keys, (key) => (bytes += key.length))
    }
    for (const child of children) {
      if (pending.length >= NODE_BUDGET) {
        truncated = true
        break
      }
      pending.push([child, level + 1])
    }
  }
  // A walk cut short saw only part of the rows; scale by the rows it was told about.
  if (truncated) {
    bytes = Math.round(bytes * Math.max(1, items / visited))
  }
  return { kind: messageKind(message), items, bytes, depth, truncated }
}

/**
 * Own data properties only, elements included: reading an accessor could change or fail the
 * message being sent. Arrays are read by index and at most the node budget of them, so a huge or
 * sparse array costs no more.
 */
function* arrayDataValues(value: readonly unknown[]): Generator<unknown> {
  for (let index = 0; index < Math.min(value.length, NODE_BUDGET); index += 1) {
    const element = Object.getOwnPropertyDescriptor(value, index)
    if (element && 'value' in element) {
      yield element.value
    }
  }
}

function* objectDataValues(
  value: object,
  keys: readonly string[],
  onKey: (key: string) => void
): Generator<unknown> {
  for (const key of keys) {
    const property = Object.getOwnPropertyDescriptor(value, key)
    if (property && 'value' in property) {
      onKey(key)
      yield property.value
    }
  }
}

function messageKind(message: unknown): string {
  if (message === null || typeof message !== 'object') {
    return typeof message
  }
  for (const field of ['type', 'kind', 'command', 'op']) {
    const value = Object.getOwnPropertyDescriptor(message, field)?.value
    if (typeof value === 'string') {
      return value
    }
  }
  return 'object'
}
