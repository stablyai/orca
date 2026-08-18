import type { AgentJournalItemIdentity } from '../../shared/agent-session-journal-types'
import {
  createAgentSessionDeltaCoalescer,
  type AgentSessionDeltaCoalescerDeps
} from '../native-chat/agent-session-wire/agent-session-delta-coalescer'
import type { StructuredAgentSessionEventSink } from '../native-chat/agent-session-wire/structured-agent-session-event-sink'
import {
  codexJournalItem,
  codexStreamingJournalItem,
  type CodexThreadItem
} from './codex-structured-item-translation'

const CODEX_ITEM_STREAM_TYPES = {
  'item/agentMessage/delta': 'agentMessage',
  'item/plan/delta': 'plan',
  'item/commandExecution/outputDelta': 'commandExecution',
  'item/fileChange/outputDelta': 'fileChange',
  'item/reasoning/summaryTextDelta': 'reasoning',
  'item/reasoning/textDelta': 'reasoning'
} as const

const PATCH_UPDATED_METHOD = 'item/fileChange/patchUpdated'
const REASONING_PART_METHOD = 'item/reasoning/summaryPartAdded'
const TERMINAL_INTERACTION_METHOD = 'item/commandExecution/terminalInteraction'

type CodexItemStreamDeps = {
  sink: StructuredAgentSessionEventSink
  identityFor: (
    threadId: string,
    params: unknown,
    item: CodexThreadItem
  ) => AgentJournalItemIdentity
  coalesceMs?: number
  schedule?: AgentSessionDeltaCoalescerDeps['schedule']
}

type StreamState = { identity: AgentJournalItemIdentity; item: CodexThreadItem }

export type CodexStructuredItemStreams = {
  track: (threadId: string, item: CodexThreadItem, identity: AgentJournalItemIdentity) => void
  handle: (threadId: string, method: string, params: unknown) => boolean
  forget: (threadId: string, itemId: string) => void
  flush: () => void
  dispose: () => void
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

export function codexStructuredItemKey(threadId: string, itemId: string): string {
  return `${encodeURIComponent(threadId)}:${encodeURIComponent(itemId)}`
}

export function createCodexStructuredItemStreams(
  deps: CodexItemStreamDeps
): CodexStructuredItemStreams {
  const states = new Map<string, StreamState>()
  const latestText = new Map<string, string>()
  const checkpointLengths = new Map<string, number>()

  const append = (state: StreamState, text: string): void => {
    const translated = codexStreamingJournalItem(state.item, text)
    if (!translated.body) {
      return
    }
    deps.sink.appendItem(state.identity, translated.body, translated.blobs)
    deps.sink.publish()
  }

  const persist = (key: string, text: string, force: boolean): void => {
    latestText.set(key, text)
    const checkpointLength = checkpointLengths.get(key) ?? 0
    const nextLength = Math.max(checkpointLength + 32, Math.ceil(checkpointLength * 1.125))
    if (!force && checkpointLength > 0 && text.length < nextLength) {
      return
    }
    checkpointLengths.set(key, text.length)
    const state = states.get(key)
    if (state) {
      append(state, text)
    }
  }

  const coalescer = createAgentSessionDeltaCoalescer({
    windowMs: deps.coalesceMs,
    schedule: deps.schedule,
    emit: (key, text) => persist(key, text, false)
  })

  const ensureState = (
    threadId: string,
    itemId: string,
    type: string,
    params: unknown
  ): StreamState => {
    const key = codexStructuredItemKey(threadId, itemId)
    const existing = states.get(key)
    if (existing) {
      return existing
    }
    const item = { type, id: itemId }
    const state = { item, identity: deps.identityFor(threadId, params, item) }
    states.set(key, state)
    return state
  }

  const flush = (): void => {
    coalescer.flushAll()
    for (const [key, text] of latestText) {
      if (checkpointLengths.get(key) !== text.length) {
        persist(key, text, true)
      }
    }
  }

  return {
    track: (threadId, item, identity) => {
      states.set(codexStructuredItemKey(threadId, item.id), { item, identity })
    },
    handle: (threadId, method, params) => {
      const paramsRecord = readRecord(params)
      const itemId = readString(paramsRecord, 'itemId')
      if (method === PATCH_UPDATED_METHOD) {
        if (!itemId || !Array.isArray(paramsRecord.changes)) {
          return true
        }
        const key = codexStructuredItemKey(threadId, itemId)
        coalescer.flush(key)
        const state = ensureState(threadId, itemId, 'fileChange', params)
        state.item = { ...state.item, changes: paramsRecord.changes }
        const translated = codexJournalItem(state.item)
        if (translated.body) {
          deps.sink.appendItem(state.identity, translated.body, translated.blobs)
          deps.sink.publish()
        }
        return true
      }
      if (method === TERMINAL_INTERACTION_METHOD) {
        return true
      }
      const type = CODEX_ITEM_STREAM_TYPES[method as keyof typeof CODEX_ITEM_STREAM_TYPES]
      if (!type && method !== REASONING_PART_METHOD) {
        return false
      }
      if (!itemId) {
        return true
      }
      const state = ensureState(threadId, itemId, type ?? 'reasoning', params)
      const delta = method === REASONING_PART_METHOD ? '\n' : paramsRecord.delta
      if (typeof delta === 'string') {
        coalescer.append(codexStructuredItemKey(threadId, state.item.id), delta)
      }
      return true
    },
    forget: (threadId, itemId) => {
      const key = codexStructuredItemKey(threadId, itemId)
      coalescer.forget(key)
      states.delete(key)
      latestText.delete(key)
      checkpointLengths.delete(key)
    },
    flush,
    dispose: () => {
      coalescer.dispose()
      states.clear()
      latestText.clear()
      checkpointLengths.clear()
    }
  }
}
