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
/** A message this large can stall or exhaust the receiving thread. */
const LARGE_BYTES = 16 * 2 ** 20
const LARGE_ITEMS = 50_000
const LARGE_DEPTH = 100
const TRUNCATED_LARGE_BYTES = 4 * 2 ** 20
const TRUNCATED_LARGE_ITEMS = 10_000
const KIND_MAX_LENGTH = 64

/** Built-in accessors: a payload's own `size` or `byteLength` getter could change what is sent. */
const MAP_SIZE = Object.getOwnPropertyDescriptor(Map.prototype, 'size')?.get
const SET_SIZE = Object.getOwnPropertyDescriptor(Set.prototype, 'size')?.get
const ARRAY_BUFFER_BYTES = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get
const TYPED_ARRAY_BYTES = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength'
)?.get
const DATA_VIEW_BYTES = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength')?.get
const mapEntries = Map.prototype.entries
const setValues = Set.prototype.values

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
    if (value instanceof ArrayBuffer) {
      bytes += Number(ARRAY_BUFFER_BYTES?.call(value) ?? 0)
      continue
    }
    if (ArrayBuffer.isView(value)) {
      bytes += Number(
        (value instanceof DataView ? DATA_VIEW_BYTES : TYPED_ARRAY_BYTES)?.call(value) ?? 0
      )
      continue
    }
    if (value instanceof Map) {
      items += Number(MAP_SIZE?.call(value) ?? 0)
      for (const [key, child] of mapEntries.call(value)) {
        if (!push(key, level + 1) || !push(child, level + 1)) {
          break
        }
      }
      continue
    }
    if (value instanceof Set) {
      items += Number(SET_SIZE?.call(value) ?? 0)
      for (const child of setValues.call(value)) {
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

/** Counts are lower bounds once a walk is cut short, so a truncated walk needs less evidence. */
export function isLargeWorkerMessage(shape: WorkerMessageShape): boolean {
  return (
    shape.bytes >= LARGE_BYTES ||
    shape.items >= LARGE_ITEMS ||
    shape.depth >= LARGE_DEPTH ||
    (shape.truncated &&
      (shape.bytes >= TRUNCATED_LARGE_BYTES || shape.items >= TRUNCATED_LARGE_ITEMS))
  )
}

function messageKind(message: unknown): string {
  if (message === null || typeof message !== 'object') {
    return typeof message
  }
  for (const field of ['type', 'kind', 'command', 'op']) {
    const value = Object.getOwnPropertyDescriptor(message, field)?.value
    if (typeof value === 'string') {
      return value.slice(0, KIND_MAX_LENGTH)
    }
  }
  return 'object'
}
