import type {
  AgentJournalItemIdentity,
  AgentJournalRenderItem
} from '../../shared/agent-session-journal-types'
import { isDeepStrictEqual } from 'node:util'
import type { CodexThreadItem } from './codex-thread-item-identity'
import { readRecord } from './codex-item-field-readers'

const TURN_TERMINAL = new Set(['completed', 'failed', 'interrupted'])
export const HISTORY_ASSOCIATION = [
  'type',
  'role',
  'agentId',
  'parentAgentId',
  'providerParentRef',
  'producerKind',
  'attempt',
  'producer',
  'senderThreadId',
  'parentCallId',
  'parentToolCallId',
  'callId'
]
export const HISTORY_ITEM_TIMINGS = [
  'startedAtMs',
  'completedAtMs',
  'startedAt',
  'completedAt'
] as const

export function terminalHistoryStatus(value: unknown): boolean {
  return typeof value === 'string' && TURN_TERMINAL.has(value)
}

export function compatibleHistoryStatus(previous: unknown, next: unknown): boolean {
  return (
    !terminalHistoryStatus(previous) ||
    next == null ||
    next === previous ||
    !['inProgress', ...TURN_TERMINAL].includes(String(next))
  )
}

export function historyInvocationFields(item: CodexThreadItem): Record<string, unknown> {
  const keys =
    item.type === 'commandExecution'
      ? ['command', 'cwd']
      : item.type === 'mcpToolCall'
        ? ['server', 'tool', 'arguments']
        : item.type === 'collabAgentToolCall'
          ? ['tool', 'prompt']
          : item.type === 'imageView'
            ? ['path']
            : item.type === 'userMessage'
              ? ['clientId', 'content']
              : []
  return Object.fromEntries(
    [...HISTORY_ASSOCIATION, ...keys]
      .filter((key) => Object.hasOwn(item, key))
      .map((key) => [key, item[key]])
  )
}

export function compatibleHistoryInvocation(
  previous: CodexThreadItem,
  next: CodexThreadItem
): boolean {
  const a = historyInvocationFields(previous),
    b = historyInvocationFields(next)
  return Object.keys(b).every((key) => !Object.hasOwn(a, key) || isDeepStrictEqual(a[key], b[key]))
}

function itemTerminal(item: CodexThreadItem): boolean {
  switch (item.type) {
    case 'commandExecution':
    case 'fileChange':
      return ['completed', 'failed', 'declined'].includes(String(item.status))
    case 'mcpToolCall':
    case 'collabAgentToolCall':
    case 'imageGeneration':
      return ['completed', 'failed', 'interrupted'].includes(String(item.status))
    default:
      return false
  }
}

export function historyItemFinality(item: CodexThreadItem): boolean {
  return (
    itemTerminal(item) ||
    HISTORY_ITEM_TIMINGS.some(
      (key) =>
        key.startsWith('completed') &&
        typeof item[key] === 'number' &&
        Number.isFinite(item[key]) &&
        item[key] !== 0
    ) ||
    (item.type === 'webSearch' && item.action != null)
  )
}

/** Sparse enrichment conserves known final values; it never merges arbitrary raw bags. */
function fillsKnown(previous: unknown, next: unknown): boolean {
  if (
    next == null ||
    previous == null ||
    previous === '' ||
    (Array.isArray(previous) && !previous.length)
  ) {
    return true
  }
  if (
    typeof previous === 'object' &&
    typeof next === 'object' &&
    !Array.isArray(previous) &&
    !Array.isArray(next)
  ) {
    const a = readRecord(previous),
      b = readRecord(next)
    return Object.keys(b).every((key) => !Object.hasOwn(a, key) || fillsKnown(a[key], b[key]))
  }
  return isDeepStrictEqual(previous, next)
}

function results(item: CodexThreadItem): Record<string, unknown> {
  const anchors = historyInvocationFields(item)
  return Object.fromEntries(
    Object.entries(item).filter(
      ([key]) =>
        !Object.hasOwn(anchors, key) &&
        !['id', 'status', 'threadId', 'turnId', ...HISTORY_ITEM_TIMINGS].includes(key)
    )
  )
}

export function reconcileHistoryItem(
  previous: { item: CodexThreadItem; final: boolean } | undefined,
  item: CodexThreadItem,
  rawTurnTerminal: boolean
): { item: CodexThreadItem; final: boolean } | null {
  if (previous) {
    const old = previous.item
    if (
      !compatibleHistoryInvocation(old, item) ||
      HISTORY_ITEM_TIMINGS.some(
        (key) =>
          key.startsWith('started') &&
          old[key] != null &&
          item[key] != null &&
          old[key] !== item[key]
      )
    ) {
      return null
    }
    if (
      itemTerminal(old) &&
      item.status != null &&
      item.status !== old.status &&
      ['inProgress', 'completed', 'failed', 'declined', 'interrupted'].includes(String(item.status))
    ) {
      return null
    }
    const oldResults = results(old),
      nextResults = results(item)
    if (item.type === 'collabAgentToolCall') {
      delete oldResults.receiverThreadIds
      delete nextResults.receiverThreadIds
    }
    if (previous.final && !fillsKnown(oldResults, nextResults)) {
      return null
    }
    const merged = { ...old, ...item, id: old.id }
    if (old.type === 'collabAgentToolCall') {
      merged.receiverThreadIds = [
        ...new Set([
          ...(Array.isArray(old.receiverThreadIds) ? old.receiverThreadIds : []),
          ...(Array.isArray(item.receiverThreadIds) ? item.receiverThreadIds : [])
        ])
      ]
      const states = { ...readRecord(old.agentsStates) }
      for (const [id, state] of Object.entries(readRecord(item.agentsStates))) {
        states[id] = { ...readRecord(states[id]), ...readRecord(state) }
      }
      merged.agentsStates = states
    }
    if (item.type === 'mcpToolCall' && (item.error !== undefined || item.result !== undefined)) {
      delete merged.error
      delete merged.result
      if (item.error !== undefined) {
        merged.error = item.error
      }
      if (item.result !== undefined) {
        merged.result = item.result
      }
    }
    if (itemTerminal(old)) {
      merged.status = old.status
    }
    for (const key of HISTORY_ITEM_TIMINGS) {
      if (old[key] != null) {
        merged[key] = old[key]
      }
    }
    item = merged
  }
  return { item, final: previous?.final === true || historyItemFinality(item) || rawTurnTerminal }
}

export type HistoryAnchor = { key: string; saved: AgentJournalRenderItem }
export type CodexHistoryObservation = NonNullable<ReturnType<typeof reconcileHistoryItem>> & {
  identity: AgentJournalItemIdentity
  saved: AgentJournalRenderItem | null
  native?: string
  parent?: string
  anchors: HistoryAnchor[]
  bytes: number
}
export type CodexHistoryObservedTurn = {
  id: string
  source: Record<string, unknown>
  items: Map<string, CodexHistoryObservation>
  saved: AgentJournalRenderItem | null
  key: string
  hidden: boolean
}
