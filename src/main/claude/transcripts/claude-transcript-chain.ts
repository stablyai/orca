import { setImmediate } from 'node:timers/promises'
import { isClaudeConversationEntry } from './claude-conversation-fork-boundary'
import { claudeRecord } from '../structured/journal/claude-structured-item-translation'
import type { ClaudeTranscriptTail } from './claude-transcript-tail'

type Row = Record<string, unknown>
type Chain<T extends Row> = { rows: T[]; rewound: boolean }

export function mainChain(
  rows: Row[],
  leafUuid: string,
  chainBoundaries: readonly string[] = []
): ClaudeTranscriptTail {
  const walk = walkMainChain(rows, leafUuid, chainBoundaries)
  let step = walk.next()
  while (!step.done) {
    step = walk.next()
  }
  return step.value
}

export async function mainChainAsync<T extends Row>(
  rows: T[],
  check: () => void,
  leafUuid = '',
  chainBoundaries: readonly string[] = []
): Promise<Chain<T>> {
  const walk = walkMainChain(rows, leafUuid, chainBoundaries)
  let count = 0
  let step = walk.next()
  while (!step.done) {
    check()
    if (++count % 256 === 0) {
      await setImmediate()
      check()
    }
    step = walk.next()
  }
  return step.value
}

function* walkMainChain<T extends Row>(
  rows: T[],
  leafUuid: string,
  chainBoundaries: readonly string[]
): Generator<void, Chain<T>> {
  const byUuid = new Map<string, T>()
  const assistants = new Map<string, T[]>()
  const results = new Map<string, T[]>()
  let newest: T | null = null
  const index = (map: Map<string, T[]>, key: unknown, row: T) => {
    if (typeof key === 'string' && key) {
      const group = map.get(key) ?? []
      group.push(row)
      map.set(key, group)
    }
  }
  for (const row of rows) {
    yield
    if (
      typeof row.uuid !== 'string' ||
      row.isSidechain === true ||
      row.parent_tool_use_id != null
    ) {
      continue
    }
    byUuid.set(row.uuid, row)
    if (isClaudeConversationEntry(row)) {
      newest = row
    }
    const message = claudeRecord(row.message)
    if (row.type === 'assistant') {
      index(assistants, message?.id, row)
    }
    if (row.type === 'user' && Array.isArray(message?.content)) {
      for (const content of message.content) {
        yield
        const part = claudeRecord(content)
        if (part?.type === 'tool_result') {
          index(results, part.tool_use_id, row)
        }
      }
    }
  }
  const kept = new Set<T>()
  let rewound = false
  for (let row = newest; row && !kept.has(row);) {
    yield
    kept.add(row)
    const parent = typeof row.parentUuid === 'string' ? row.parentUuid : row.logicalParentUuid
    if (parent === leafUuid || (typeof parent === 'string' && chainBoundaries.includes(parent))) {
      break
    }
    const next = typeof parent === 'string' ? byUuid.get(parent) : undefined
    if (!next || kept.has(next)) {
      rewound = true
      break
    }
    row = next
  }
  // Set iteration includes newly kept siblings and results, closing nested tool forks in one pass.
  for (const row of kept) {
    yield
    const message = claudeRecord(row.message)
    if (row.type === 'assistant' && typeof message?.id === 'string') {
      for (const sibling of assistants.get(message.id) ?? []) {
        yield
        kept.add(sibling)
      }
      assistants.delete(message.id)
    }
    if (Array.isArray(message?.content)) {
      for (const content of message.content) {
        yield
        const part = claudeRecord(content)
        if (part?.type === 'tool_use' && typeof part.id === 'string') {
          for (const result of results.get(part.id) ?? []) {
            yield
            kept.add(result)
          }
          results.delete(part.id)
        }
      }
    }
  }
  const selected: T[] = []
  for (const row of rows) {
    yield
    if (kept.has(row)) {
      selected.push(row)
    }
  }
  return { rows: selected, rewound }
}
