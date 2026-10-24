import { restoreCodexTextState, finishCodexStreams } from './codex-stream-finishes'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalRowAttribution
} from '../../shared/agent-session-journal-types'
import {
  createAgentSessionDeltaCoalescer,
  type AgentSessionDeltaWindow
} from '../native-chat/agent-session-wire/agent-session-delta-coalescer'
import { CodexItemStreamRetention } from './codex-item-stream-retention'
import { appendCodexItemAndPublish, appendCodexStreamWindow } from './codex-structured-journal-sink'
import { codexJournalItem } from './codex-structured-item-translation'
import {
  codexStructuredItemKey,
  MAX_CODEX_ITEM_STREAM_PENDING_PATCH_BYTES,
  MAX_CODEX_ITEM_STREAM_RETAINED_BYTES,
  codexItemStreamState,
  codexToolStreamWindowDue,
  evictCodexPendingPatches,
  pendingPatchBytes
} from './codex-structured-item-stream-bounds'
import {
  CODEX_ITEM_STREAM_TYPES,
  codexPatchChangeBytes,
  PATCH_UPDATED_METHOD,
  readCodexItemStreamRecord,
  readCodexItemStreamString,
  REASONING_PART_METHOD,
  TERMINAL_INTERACTION_METHOD
} from './codex-structured-item-stream-events'
import type {
  CodexItemStreamDeps,
  CodexItemStreamState,
  CodexPendingItemPatch,
  CodexStructuredItemStreamAdmission,
  CodexStructuredItemStreams
} from './codex-structured-item-stream-contracts'
export type {
  CodexStructuredItemStreamAdmission,
  CodexStructuredItemStreamHandleResult,
  CodexStructuredItemStreams
} from './codex-structured-item-stream-contracts'
export { codexStructuredItemKey } from './codex-structured-item-stream-bounds'
export {
  MAX_CODEX_ITEM_STREAM_PENDING_PATCH_BYTES,
  MAX_CODEX_ITEM_STREAM_RETAINED_BYTES,
  MAX_CODEX_ITEM_STREAM_PENDING_PATCHES,
  MAX_CODEX_ITEM_STREAM_STATES
} from './codex-structured-item-stream-bounds'
export function createCodexStructuredItemStreams(
  deps: CodexItemStreamDeps
): CodexStructuredItemStreams {
  const states = new CodexItemStreamRetention()
  const checkpointLengths = new Map<string, number>()
  const pendingCheckpoints = new Set<string>()
  // Resolve attribution on each append so later-discovered parents reach existing rows.
  const producers = new Map<string, { threadId: string; turnId: string | null }>()
  const attributionOf = (key: string): AgentJournalRowAttribution => {
    const producer = producers.get(key)
    return producer
      ? deps.attributionFor(producer.threadId, producer.turnId)
      : { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  }
  // Retain rejected patch snapshots for retry; they have no coalescer timer.
  const pendingPatches = new Map<string, CodexPendingItemPatch>()
  let retainedPatchBytes = 0

  const forgetState = (key: string): void => {
    coalescer.forget(key)
    states.forget(key)
    checkpointLengths.delete(key)
    pendingCheckpoints.delete(key)
    producers.delete(key)
    const pending = pendingPatches.get(key)
    if (pending) {
      retainedPatchBytes = Math.max(0, retainedPatchBytes - pendingPatchBytes(pending))
      pendingPatches.delete(key)
    }
  }

  const trimStates = (): void => {
    while (states.overCapacity) {
      const oldest = states.oldestEvictable()
      if (typeof oldest !== 'string') {
        break
      }
      if (!coalescer.flush(oldest)) {
        // Keep the state (and its buffered text) until the sink recovers. A
        // bounded map is preferable to silently losing streamed output.
        break
      }
      forgetState(oldest)
    }
  }

  const append = (
    key: string,
    state: CodexItemStreamState,
    text: string,
    window?: AgentSessionDeltaWindow
  ): boolean =>
    appendCodexStreamWindow(deps, producers.get(key)!, state, text, attributionOf(key), window)

  const persist = (key: string, text: string): boolean => {
    const state = states.get(key)
    if (state && append(key, state, text)) {
      checkpointLengths.set(key, text.length)
      pendingCheckpoints.delete(key)
      return true
    }
    return false
  }

  const coalescer = createAgentSessionDeltaCoalescer({
    source: deps.sink.textSource
      ? (key) => {
          const state = states.get(key)
          return state ? deps.sink.textSource?.(state.identity) : undefined
        }
      : undefined,
    windowMs: deps.coalesceMs,
    maxRetainedBytes: deps.maxRetainedBytes,
    maxTotalRetainedBytes: deps.maxTotalRetainedBytes,
    isProtected: (key) => states.isPersistent(key),
    schedule: deps.schedule,
    emitDelta: (key, window) => {
      const state = states.get(key)
      if (!state) {
        return false
      }
      if (state.item.type !== 'agentMessage' && state.item.type !== 'reasoning') {
        if (!codexToolStreamWindowDue(window, checkpointLengths.get(key))) {
          return true
        }
        return persist(key, window.text())
      }
      if (state.item.type === 'reasoning' && !window.hasText) {
        return true
      }
      if (!append(key, state, deps.sink.prepareText ? 'x' : window.text(), window)) {
        return false
      }
      checkpointLengths.set(key, window.length)
      pendingCheckpoints.delete(key)
      return true
    },
    emit: (key, text) => persist(key, text)
  })

  const ensureState = (
    threadId: string,
    itemId: string,
    type: string,
    params: unknown
  ): CodexItemStreamState => {
    const key = codexStructuredItemKey(threadId, itemId)
    const existing = states.get(key)
    if (existing) {
      return existing
    }
    const turnId = deps.turnIdFor(threadId, params)
    const state = restoreCodexTextState(deps, threadId, turnId, itemId, type)
    states.retain(key, state)
    producers.set(key, { threadId, turnId })
    trimStates()
    return state
  }

  const flush = (): boolean => {
    let flushed = coalescer.flushAll()
    for (const key of pendingCheckpoints) {
      const snapshot = coalescer.snapshot(key)
      if (
        snapshot &&
        !deps.sink.textSource?.(states.get(key)!.identity) &&
        checkpointLengths.get(key) !== snapshot.text.length
      ) {
        flushed = persist(key, snapshot.text) && flushed
      } else {
        pendingCheckpoints.delete(key)
      }
    }
    for (const key of pendingPatches.keys()) {
      flushed = flushPatch(key).accepted && flushed
    }
    return flushed
  }

  const flushPatch = (key: string): CodexStructuredItemStreamAdmission => {
    const pending = pendingPatches.get(key)
    if (!pending) {
      return { accepted: true }
    }
    const admission = appendCodexItemAndPublish(
      deps.sink,
      pending.identity,
      pending.body,
      attributionOf(key)
    )
    if (!admission.accepted) {
      return admission
    }
    retainedPatchBytes = Math.max(0, retainedPatchBytes - pendingPatchBytes(pending))
    pendingPatches.delete(key)
    return { accepted: true }
  }

  return {
    get persistentCount() {
      return states.persistentSize
    },
    track: (threadId, turnId, item, identity, startedAt) => {
      const key = codexStructuredItemKey(threadId, item.id)
      states.retain(key, codexItemStreamState(item, identity, startedAt))
      producers.set(key, { threadId, turnId })
      trimStates()
    },
    handle: (threadId, method, params) => {
      const paramsRecord = readCodexItemStreamRecord(params)
      const itemId = readCodexItemStreamString(paramsRecord, 'itemId')
      if (method === PATCH_UPDATED_METHOD) {
        if (!itemId || !Array.isArray(paramsRecord.changes)) {
          return { handled: true, admission: { accepted: true } }
        }
        if (
          codexPatchChangeBytes(paramsRecord.changes) > MAX_CODEX_ITEM_STREAM_PENDING_PATCH_BYTES
        ) {
          return { handled: true, admission: { accepted: false, reason: 'backpressure' } }
        }
        const key = codexStructuredItemKey(threadId, itemId)
        const streamFlushed = coalescer.flush(key)
        const state = ensureState(threadId, itemId, 'fileChange', params)
        state.item = { ...state.item, changes: paramsRecord.changes }
        const translated = codexJournalItem(state.item)
        if (translated.body) {
          const nextPending: CodexPendingItemPatch = {
            identity: state.identity,
            body: translated.body
          }
          const previous = pendingPatches.get(key)
          const previousBytes = previous ? pendingPatchBytes(previous) : 0
          const nextBytes = pendingPatchBytes(nextPending)
          if (
            nextBytes > MAX_CODEX_ITEM_STREAM_PENDING_PATCH_BYTES ||
            retainedPatchBytes - previousBytes + nextBytes > MAX_CODEX_ITEM_STREAM_RETAINED_BYTES
          ) {
            return { handled: true, admission: { accepted: false, reason: 'backpressure' } }
          }
          retainedPatchBytes = Math.max(0, retainedPatchBytes - previousBytes) + nextBytes
          pendingPatches.set(key, nextPending)
          retainedPatchBytes = Math.max(
            0,
            retainedPatchBytes - evictCodexPendingPatches(pendingPatches)
          )
          if (streamFlushed) {
            const admission = flushPatch(key)
            if (!admission.accepted) {
              return { handled: true, admission }
            }
          }
        }
        return { handled: true, admission: { accepted: true } }
      }
      if (method === TERMINAL_INTERACTION_METHOD) {
        return { handled: true, admission: { accepted: true } }
      }
      const type = CODEX_ITEM_STREAM_TYPES[method as keyof typeof CODEX_ITEM_STREAM_TYPES]
      if (!type && method !== REASONING_PART_METHOD) {
        return { handled: false, admission: { accepted: true } }
      }
      if (!itemId) {
        return { handled: true, admission: { accepted: true } }
      }
      const state = ensureState(threadId, itemId, type ?? 'reasoning', params)
      const delta = method === REASONING_PART_METHOD ? '\n' : paramsRecord.delta
      if (typeof delta === 'string') {
        const key = codexStructuredItemKey(threadId, state.item.id)
        pendingCheckpoints.add(key)
        const accepted = coalescer.append(key, delta)
        if (!accepted) {
          return { handled: true, admission: { accepted: false, reason: 'backpressure' } }
        }
      }
      return { handled: true, admission: { accepted: true } }
    },
    forget: (threadId, itemId) => {
      const key = codexStructuredItemKey(threadId, itemId)
      forgetState(key)
    },
    finish: (threadId, turnId, at, item) =>
      finishCodexStreams(deps, states, producers, coalescer, forgetState, {
        threadId,
        turnId,
        at,
        item,
        historyImport: deps.historyImport
      }),
    flush,
    dispose: () => {
      coalescer.dispose()
      states.clear()
      checkpointLengths.clear()
      pendingCheckpoints.clear()
      producers.clear()
      pendingPatches.clear()
      retainedPatchBytes = 0
    },
    snapshot: (threadId, itemId) => {
      const key = codexStructuredItemKey(threadId, itemId)
      return coalescer.snapshot(key)
    }
  }
}
