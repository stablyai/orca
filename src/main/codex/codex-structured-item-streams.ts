import { agentJournalItemKey } from '../../shared/agent-session-journal-item-key'
import { createAgentSessionDeltaCoalescer } from '../native-chat/agent-session-wire/agent-session-delta-coalescer'
import {
  codexJournalItem,
  codexStreamingJournalItem,
  type CodexThreadItem
} from './codex-structured-item-translation'
import {
  codexStructuredItemKey,
  MAX_CODEX_ITEM_STREAM_PENDING_PATCHES,
  MAX_CODEX_ITEM_STREAM_PENDING_PATCH_BYTES,
  MAX_CODEX_ITEM_STREAM_RETAINED_BYTES,
  MAX_CODEX_ITEM_STREAM_STATES,
  boundStreamItem,
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
/** Delta-only item ids are provider input; retain only a deterministic recent window. */

export function createCodexStructuredItemStreams(
  deps: CodexItemStreamDeps
): CodexStructuredItemStreams {
  const states = new Map<string, CodexItemStreamState>()
  const checkpointLengths = new Map<string, number>()
  // Patch updates are authoritative item snapshots. Keep the latest rejected
  // snapshot until the journal admits it; unlike streamed deltas, there is no
  // coalescer timer to retry these events for us.
  const pendingPatches = new Map<string, CodexPendingItemPatch>()
  let retainedPatchBytes = 0

  const forgetState = (key: string): void => {
    coalescer.forget(key)
    states.delete(key)
    checkpointLengths.delete(key)
    const pending = pendingPatches.get(key)
    if (pending) {
      retainedPatchBytes = Math.max(0, retainedPatchBytes - pendingPatchBytes(pending))
      pendingPatches.delete(key)
    }
  }

  const trimStates = (): void => {
    while (states.size > MAX_CODEX_ITEM_STREAM_STATES) {
      const oldest = states.keys().next().value
      if (typeof oldest !== 'string') {
        break
      }
      const pending = coalescer.snapshot(oldest)
      if (pending && pending.text.length > 0 && !persist(oldest, pending.text, true)) {
        // Keep the state (and its buffered text) until the sink recovers. A
        // bounded map is preferable to silently losing streamed output.
        break
      }
      forgetState(oldest)
    }
  }

  const trimPendingPatches = (): void => {
    while (pendingPatches.size > MAX_CODEX_ITEM_STREAM_PENDING_PATCHES) {
      const oldest = pendingPatches.keys().next().value
      if (typeof oldest !== 'string') {
        break
      }
      const pending = pendingPatches.get(oldest)
      if (pending) {
        retainedPatchBytes = Math.max(0, retainedPatchBytes - pendingPatchBytes(pending))
      }
      pendingPatches.delete(oldest)
    }
  }

  const append = (state: CodexItemStreamState, text: string): boolean => {
    const translated = codexStreamingJournalItem(state.item, text)
    if (!translated.body) {
      return true
    }
    const options = { coalescingKey: `checkpoint:${agentJournalItemKey(state.identity)}` }
    const admission = deps.sink.tryAppendItem
      ? deps.sink.tryAppendItem(state.identity, translated.body, translated.blobs, options)
      : (deps.sink.appendItem(state.identity, translated.body, translated.blobs, options),
        { accepted: true as const })
    if (!admission.accepted) {
      return false
    }
    const published = deps.sink.tryPublish
      ? deps.sink.tryPublish()
      : (deps.sink.publish(), { accepted: true as const })
    return published.accepted
  }

  const persist = (key: string, text: string, force: boolean): boolean => {
    const checkpointLength = checkpointLengths.get(key) ?? 0
    const nextLength = Math.max(checkpointLength + 32, Math.ceil(checkpointLength * 1.125))
    if (!force && checkpointLength > 0 && text.length < nextLength) {
      return true
    }
    const state = states.get(key)
    if (state && append(state, text)) {
      checkpointLengths.set(key, text.length)
      return true
    }
    return false
  }

  const coalescer = createAgentSessionDeltaCoalescer({
    windowMs: deps.coalesceMs,
    maxRetainedBytes: deps.maxRetainedBytes,
    maxTotalRetainedBytes: deps.maxTotalRetainedBytes,
    schedule: deps.schedule,
    emit: (key, text) => {
      return persist(key, text, false)
    }
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
    const item = { type, id: itemId }
    const state = { item, identity: deps.identityFor(threadId, params, item) }
    states.set(key, state)
    trimStates()
    return state
  }

  const flush = (): boolean => {
    let flushed = coalescer.flushAll()
    for (const key of states.keys()) {
      const snapshot = coalescer.snapshot(key)
      if (snapshot && checkpointLengths.get(key) !== snapshot.text.length) {
        flushed = persist(key, snapshot.text, true) && flushed
      }
    }
    for (const [key, pending] of pendingPatches) {
      const admission = deps.sink.tryAppendItem
        ? deps.sink.tryAppendItem(pending.identity, pending.body, pending.blobs)
        : (deps.sink.appendItem(pending.identity, pending.body, pending.blobs),
          { accepted: true as const })
      if (!admission.accepted) {
        flushed = false
        continue
      }
      const published = deps.sink.tryPublish
        ? deps.sink.tryPublish()
        : (deps.sink.publish(), { accepted: true as const })
      if (!published.accepted) {
        flushed = false
        continue
      }
      retainedPatchBytes = Math.max(0, retainedPatchBytes - pendingPatchBytes(pending))
      pendingPatches.delete(key)
    }
    return flushed
  }

  const flushPatch = (key: string): CodexStructuredItemStreamAdmission => {
    const pending = pendingPatches.get(key)
    if (!pending) {
      return { accepted: true }
    }
    const admission = deps.sink.tryAppendItem
      ? deps.sink.tryAppendItem(pending.identity, pending.body, pending.blobs)
      : (deps.sink.appendItem(pending.identity, pending.body, pending.blobs),
        { accepted: true as const })
    if (!admission.accepted) {
      return admission
    }
    const published = deps.sink.tryPublish
      ? deps.sink.tryPublish()
      : (deps.sink.publish(), { accepted: true as const })
    if (!published.accepted) {
      return published
    }
    retainedPatchBytes = Math.max(0, retainedPatchBytes - pendingPatchBytes(pending))
    pendingPatches.delete(key)
    return { accepted: true }
  }

  return {
    track: (threadId, item, identity) => {
      const key = codexStructuredItemKey(threadId, item.id)
      states.delete(key)
      states.set(key, { item: boundStreamItem(item) as CodexThreadItem, identity })
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
            body: translated.body,
            blobs: translated.blobs
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
          trimPendingPatches()
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
        const accepted = coalescer.append(codexStructuredItemKey(threadId, state.item.id), delta)
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
    flush,
    dispose: () => {
      coalescer.dispose()
      states.clear()
      checkpointLengths.clear()
      pendingPatches.clear()
      retainedPatchBytes = 0
    },
    snapshot: (threadId, itemId) => {
      const key = codexStructuredItemKey(threadId, itemId)
      return coalescer.snapshot(key)
    }
  }
}
