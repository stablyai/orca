export type WorkerMessageShape = {
  kind: string
  /** Lengths of the arrays, maps, sets and keyed objects reached. */
  items: number
  /** Rough clone size: string lengths, buffer lengths, 8 per scalar, within the budget. */
  bytes: number
  depth: number
  /** The walk stopped at its budget, so the counts are lower bounds. */
  truncated: boolean
}

const NODE_BUDGET = 2048
/** Keys and elements examined per message, across every object: bounds wide and cyclic payloads. */
const ENTRY_BUDGET = 16_384
/** An object with more keys than this is a keyed collection (a Record of rows), not a struct. */
const RECORD_ENTRY_KEYS = 64

/**
 * Bounded and iterative, visiting each object once, so a huge, wide, deep or cyclic payload costs
 * the sender at most the budget.
 */
export function describeWorkerMessage(message: unknown): WorkerMessageShape {
  let items = 0
  let bytes = 0
  let depth = 0
  let visited = 0
  let entries = 0
  let truncated = false
  const seen = new Set<object>()
  const pending: [unknown, number][] = [[message, 1]]
  const push = (child: unknown, level: number): boolean => {
    if (pending.length >= NODE_BUDGET || ++entries > ENTRY_BUDGET) {
      truncated = true
      return false
    }
    pending.push([child, level])
    return true
  }
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
    if (seen.has(value)) {
      continue
    }
    seen.add(value)
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      bytes += value.byteLength
      continue
    }
    if (value instanceof Map || value instanceof Set) {
      items += value.size
      for (const child of value.values()) {
        if (!push(child, level + 1)) {
          break
        }
      }
      continue
    }
    if (Array.isArray(value)) {
      items += value.length
      truncated ||= value.length > NODE_BUDGET
      // By index: for...in would list every index first. Own data only: an accessor could
      // change or fail the message being sent.
      for (let index = 0; index < Math.min(value.length, NODE_BUDGET); index += 1) {
        const element = Object.getOwnPropertyDescriptor(value, index)
        if (element && 'value' in element && !push(element.value, level + 1)) {
          break
        }
      }
      continue
    }
    const keys = Object.keys(value)
    if (keys.length > RECORD_ENTRY_KEYS) {
      items += keys.length
      truncated ||= keys.length > NODE_BUDGET
    }
    for (const key of keys) {
      const property = Object.getOwnPropertyDescriptor(value, key)
      if (property && 'value' in property) {
        bytes += key.length
        if (!push(property.value, level + 1)) {
          break
        }
      }
    }
  }
  return { kind: messageKind(message), items, bytes, depth, truncated }
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
