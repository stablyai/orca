const TOOL_INPUT_CHARACTER_LIMIT = 4_000
const TOOL_INPUT_COLLECTION_LIMIT = 20
const TOOL_INPUT_DEPTH_LIMIT = 5
const TOOL_INPUT_KEY_LIMIT = 128
const TOOL_INPUT_NODE_LIMIT = 100
const TRUNCATION_MARKER = '… (truncated)'

type ToolInputBudget = {
  characters: number
  nodes: number
  seen: WeakSet<object>
}

export function sanitizeMobileWebNativeChatToolInput(value: unknown): unknown {
  return sanitizeValue(
    value,
    {
      characters: TOOL_INPUT_CHARACTER_LIMIT,
      nodes: TOOL_INPUT_NODE_LIMIT,
      seen: new WeakSet<object>()
    },
    0
  )
}

function sanitizeValue(value: unknown, budget: ToolInputBudget, depth: number): unknown {
  budget.nodes -= 1
  if (budget.nodes < 0 || budget.characters <= 0) {
    return TRUNCATION_MARKER
  }
  if (typeof value === 'string') {
    return boundedString(value, budget)
  }
  if (value === null || typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value !== 'object') {
    return null
  }
  if (budget.seen.has(value)) {
    return TRUNCATION_MARKER
  }
  if (depth >= TOOL_INPUT_DEPTH_LIMIT) {
    return TRUNCATION_MARKER
  }
  budget.seen.add(value)
  return Array.isArray(value)
    ? sanitizeArray(value, budget, depth)
    : sanitizeRecord(value as Record<string, unknown>, budget, depth)
}

function boundedString(value: string, budget: ToolInputBudget): string {
  const length = Math.min(value.length, budget.characters)
  budget.characters -= length
  return length < value.length ? `${value.slice(0, length)}${TRUNCATION_MARKER}` : value
}

function sanitizeArray(value: unknown[], budget: ToolInputBudget, depth: number): unknown[] {
  const result = value
    .slice(0, TOOL_INPUT_COLLECTION_LIMIT)
    .map((item) => sanitizeValue(item, budget, depth + 1))
  if (value.length > TOOL_INPUT_COLLECTION_LIMIT) {
    result.push(TRUNCATION_MARKER)
  }
  return result
}

function sanitizeRecord(
  value: Record<string, unknown>,
  budget: ToolInputBudget,
  depth: number
): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null)
  let count = 0
  for (const key in value) {
    if (!Object.hasOwn(value, key)) {
      continue
    }
    if (count >= TOOL_INPUT_COLLECTION_LIMIT || budget.characters <= 0) {
      addTruncationProperty(result)
      break
    }
    const keyLength = Math.min(key.length, TOOL_INPUT_KEY_LIMIT, budget.characters)
    const boundedKey = uniqueKey(result, key.slice(0, keyLength), count)
    budget.characters -= keyLength
    result[boundedKey] = sanitizeValue(value[key], budget, depth + 1)
    count += 1
  }
  return result
}

function uniqueKey(result: Record<string, unknown>, key: string, index: number): string {
  return Object.hasOwn(result, key) ? `${key}~${index}` : key
}

function addTruncationProperty(result: Record<string, unknown>): void {
  result[uniqueKey(result, '…', Object.keys(result).length)] = 'truncated'
}
