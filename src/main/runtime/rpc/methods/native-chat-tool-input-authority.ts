import {
  defineToolInputValue,
  selectToolInputPath,
  TOOL_PATH_KEYS,
  TOOL_PRIMARY_KEYS
} from '../../../../shared/native-chat-tool-input-metadata'
import {
  OMIT_INPUT,
  TOOL_INPUT_LIMITS,
  type InputBudget,
  type ToolInputProjection
} from './native-chat-tool-input-projection'

type Argument = { search: boolean | 'unknown'; label: boolean | 'unknown'; value: unknown }
export type InputAuthority = {
  values: Record<string, unknown>
  budget: InputBudget
  omit: Set<string>
}
const UNKNOWN_PATH = Symbol('unknown path')

export function planToolInputAuthority(
  value: object,
  projection: ToolInputProjection
): InputAuthority {
  const budget = { chars: TOOL_INPUT_LIMITS.metadata as number, nodes: TOOL_INPUT_LIMITS.nodes - 1 }
  const values: Record<string, unknown> = {}
  const omit = new Set<string>([...TOOL_PATH_KEYS, 'query', 'pattern'])
  const args = new Map<string, Argument>()
  const read = (key: string): unknown => projection.read(value, key)
  const argument = (key: string): Argument => {
    const cached = args.get(key)
    if (cached) {
      return cached
    }
    const input = read(key)
    const result = inspectArgument(input, key, projection)
    args.set(key, result)
    return result
  }
  const search = (): boolean | 'unknown' => {
    const query = argument('query').search,
      pattern = argument('pattern').search
    return query === true || pattern === true
      ? true
      : query === 'unknown' || pattern === 'unknown'
        ? 'unknown'
        : false
  }
  let prefix: unknown[] | undefined
  const patch = (): unknown => {
    const changes = read('changes')
    if (!Array.isArray(changes)) {
      return undefined
    }
    const length = projection.read(changes, 'length') as number
    prefix = []
    for (let index = 0; index < Math.min(length, TOOL_INPUT_LIMITS.items); index++) {
      const change = projection.read(changes, String(index))
      if (change !== null && typeof change === 'object') {
        const path = projection.read(change, 'path')
        if (typeof path === 'string') {
          prefix.push({ path })
          return path
        }
        prefix.push(Array.isArray(change) ? [] : {})
      } else {
        prefix.push(
          change === undefined ||
            typeof change === 'function' ||
            typeof change === 'symbol' ||
            typeof change === 'bigint'
            ? null
            : change
        )
      }
    }
    return length > TOOL_INPUT_LIMITS.items ? UNKNOWN_PATH : undefined
  }
  const selected = selectToolInputPath(read, search, patch)
  const reserve = (key: string, input: unknown): boolean => {
    if (key.length > budget.chars) {
      return false
    }
    budget.chars -= key.length
    const projected = projection.project(input, budget, 1, true)
    if (projected === OMIT_INPUT) {
      return false
    }
    defineToolInputValue(values, key, projected)
    return true
  }
  const suppressPrimary = (): void => {
    for (const key of TOOL_PRIMARY_KEYS) {
      omit.add(key)
    }
  }
  if (selected === 'unknown' || (selected && selected.value === UNKNOWN_PATH)) {
    suppressPrimary()
  } else if (selected && typeof selected.value === 'string' && selected.value.length > 0) {
    let retained = reserve(selected.key, selected.key === 'changes' ? prefix : selected.value)
    if (retained && selected.key === 'path') {
      for (const key of ['query', 'pattern']) {
        const arg = argument(key)
        if (arg.search === 'unknown' || (arg.value !== undefined && !reserve(key, arg.value))) {
          retained = false
          break
        }
      }
    }
    if (!retained) {
      for (const key of Object.keys(values)) {
        delete values[key]
      }
      suppressPrimary()
    }
  } else {
    const query = argument('query')
    const winner = query.label === false ? argument('pattern') : query
    const key = query.label === false ? 'pattern' : 'query'
    if (winner.label === 'unknown' || (winner.label && !reserve(key, winner.value))) {
      suppressPrimary()
    }
  }
  return { values, budget, omit }
}

function inspectArgument(value: unknown, key: string, projection: ToolInputProjection): Argument {
  const unknown: Argument = { search: 'unknown', label: 'unknown', value }
  if (typeof value === 'string') {
    if (value.length + key.length > TOOL_INPUT_LIMITS.metadata) {
      return unknown
    }
    const nonblank = projection.nonblank(value)
    return { search: nonblank, label: nonblank, value }
  }
  if (!Array.isArray(value)) {
    return { search: false, label: false, value }
  }
  const length = projection.read(value, 'length') as number
  if (length > TOOL_INPUT_LIMITS.items) {
    return unknown
  }
  if (length === 0) {
    return { search: false, label: false, value }
  }
  let chars = key.length
  const parts: string[] = []
  for (let index = 0; index < length; index++) {
    const part = projection.read(value, String(index))
    if (typeof part !== 'string') {
      return { search: false, label: false, value }
    }
    chars += part.length
    if (chars > TOOL_INPUT_LIMITS.metadata) {
      return unknown
    }
    parts.push(part)
  }
  return { search: true, label: parts.some((part) => projection.nonblank(part)), value }
}
