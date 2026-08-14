import type { JsonValue as CodexStructuredJsonValue } from '../../shared/ephemeral-vm-recipes'

const MAX_CHANGE_KIND_DEPTH = 32
const MAX_CHANGE_KIND_NODES = 16_384
const MAX_CHANGE_KIND_ENCODED_BYTES = 2 * 1024 * 1024
const NOT_SCALAR = Symbol('not-scalar')

type VisitTask = {
  type: 'visit'
  input: unknown
  depth: number
  assign: (value: CodexStructuredJsonValue) => void
}

type ExitTask = { type: 'exit'; input: object }

export function normalizeCodexFileChangeKind(
  input: unknown
): { value: CodexStructuredJsonValue; encodedBytes: number } | null {
  let root: CodexStructuredJsonValue | undefined
  let encodedBytes = 0
  let reservedNodes = 1
  const active = new WeakSet<object>()
  const tasks: (VisitTask | ExitTask)[] = [
    { type: 'visit', input, depth: 0, assign: (value) => (root = value) }
  ]
  while (tasks.length > 0) {
    const task = tasks.pop()!
    if (task.type === 'exit') {
      active.delete(task.input)
      continue
    }
    if (task.depth > MAX_CHANGE_KIND_DEPTH) {
      return null
    }
    const scalar = normalizedScalar(task.input)
    if (scalar !== NOT_SCALAR) {
      if (typeof scalar === 'string' && Buffer.byteLength(scalar) > MAX_CHANGE_KIND_ENCODED_BYTES) {
        return null
      }
      encodedBytes += Buffer.byteLength(JSON.stringify(scalar))
      if (encodedBytes > MAX_CHANGE_KIND_ENCODED_BYTES) {
        return null
      }
      task.assign(scalar)
      continue
    }
    if (typeof task.input !== 'object' || task.input === null || active.has(task.input)) {
      return null
    }
    const source = task.input
    active.add(source)
    tasks.push({ type: 'exit', input: source })
    const addBytes = (bytes: number): boolean => {
      encodedBytes += bytes
      return encodedBytes <= MAX_CHANGE_KIND_ENCODED_BYTES
    }
    const reserveNodes = (count: number): boolean => {
      if (count > MAX_CHANGE_KIND_NODES - reservedNodes) {
        return false
      }
      reservedNodes += count
      return true
    }
    const accepted = Array.isArray(source)
      ? visitArray(source, task, tasks, addBytes, reserveNodes)
      : visitRecord(source, task, tasks, addBytes, reserveNodes)
    if (!accepted) {
      return null
    }
  }
  return root === undefined ? null : { value: root, encodedBytes }
}

function visitArray(
  source: unknown[],
  task: VisitTask,
  tasks: (VisitTask | ExitTask)[],
  addBytes: (bytes: number) => boolean,
  reserveNodes: (count: number) => boolean
): boolean {
  if (!reserveNodes(source.length)) {
    return false
  }
  const keys = Reflect.ownKeys(source)
  if (
    keys.length !== source.length + 1 ||
    keys.some((key) =>
      typeof key === 'symbol'
        ? true
        : key !== 'length' && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= source.length)
    )
  ) {
    return false
  }
  const output: CodexStructuredJsonValue[] = []
  output.length = source.length
  if (!addBytes(2 + Math.max(0, source.length - 1))) {
    return false
  }
  task.assign(output)
  for (let index = source.length - 1; index >= 0; index -= 1) {
    const descriptor = Object.getOwnPropertyDescriptor(source, String(index))
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      return false
    }
    tasks.push({
      type: 'visit',
      input: descriptor.value,
      depth: task.depth + 1,
      assign: (value) => (output[index] = value)
    })
  }
  return true
}

function visitRecord(
  source: object,
  task: VisitTask,
  tasks: (VisitTask | ExitTask)[],
  addBytes: (bytes: number) => boolean,
  reserveNodes: (count: number) => boolean
): boolean {
  const prototype = Object.getPrototypeOf(source)
  if (prototype !== Object.prototype && prototype !== null) {
    return false
  }
  const keys = Reflect.ownKeys(source)
  if (!reserveNodes(keys.length) || keys.some((key) => typeof key === 'symbol')) {
    return false
  }
  const output: Record<string, CodexStructuredJsonValue> = {}
  if (!addBytes(2 + Math.max(0, keys.length - 1))) {
    return false
  }
  task.assign(output)
  for (let index = keys.length - 1; index >= 0; index -= 1) {
    const key = keys[index] as string
    const descriptor = Object.getOwnPropertyDescriptor(source, key)
    if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
      return false
    }
    if (Buffer.byteLength(key) > MAX_CHANGE_KIND_ENCODED_BYTES) {
      return false
    }
    if (!addBytes(Buffer.byteLength(JSON.stringify(key)) + 1)) {
      return false
    }
    Object.defineProperty(output, key, {
      value: null,
      writable: true,
      enumerable: true,
      configurable: true
    })
    tasks.push({
      type: 'visit',
      input: descriptor.value,
      depth: task.depth + 1,
      assign: (value) => (output[key] = value)
    })
  }
  return true
}

function normalizedScalar(value: unknown): null | boolean | number | string | typeof NOT_SCALAR {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return value
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : NOT_SCALAR
}
