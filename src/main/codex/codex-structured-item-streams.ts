import {
  CodexItemStreamCheckpoints,
  flushCodexItemStreamCheckpoints
} from './codex-structured-item-stream-checkpoints'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalRowAttribution
} from '../../shared/agent-session-journal-types'
import { createAgentSessionDeltaCoalescer } from '../native-chat/agent-session-wire/agent-session-delta-coalescer'
import { CodexItemStreamRetention } from './codex-item-stream-retention'
import { appendCodexItemAndPublish } from './codex-structured-journal-sink'
import { codexJournalItem, codexStreamingJournalItem } from './codex-structured-item-translation'
import { withJournalReasoningLifecycle } from '../native-chat/agent-session-journal/journal-reasoning-row'
import {
  codexStructuredItemKey,
  MAX_CODEX_ITEM_STREAM_PENDING_PATCH_BYTES,
  MAX_CODEX_ITEM_STREAM_RETAINED_BYTES,
  codexItemStreamState,
  pendingPatchBytes,
  trimCodexPendingPatches
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
export type { CodexStructuredItemStreams } from './codex-structured-item-stream-contracts'
export function createCodexStructuredItemStreams(
  deps: CodexItemStreamDeps
): CodexStructuredItemStreams {
  const states = new CodexItemStreamRetention()
  const checkpointLengths = new Map<string, number>()
  const acceptedAt = new Map<string, number>()
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
  const checkpoints = new CodexItemStreamCheckpoints({
    pending: pendingCheckpoints,
    typeFor: (key) => states.get(key)?.item.type,
    acceptedAt,
    checkpointLengths,
    persist: (key) => {
      const snapshot = coalescer.snapshot(key)
      return snapshot ? persist(key, snapshot.text) : { accepted: true }
    },
    schedule: deps.schedule,
    windowMs: deps.coalesceMs,
    isCurrent: deps.isCurrent,
    onScheduledFailure: deps.onScheduledFailure,
    sink: deps.sink,
    pendingPatches,
    attributionOf,
    releasePatch: (bytes) => {
      retainedPatchBytes = Math.max(0, retainedPatchBytes - bytes)
    }
  })

  const forgetState = (key: string): void => {
    coalescer.forget(key)
    states.forget(key)
    checkpointLengths.delete(key)
    acceptedAt.delete(key)
    pendingCheckpoints.delete(key)
    if (pendingCheckpoints.size === 0) {
      checkpoints.cancel()
    }
    producers.delete(key)
    const pending = pendingPatches.get(key)
    if (pending) {
      retainedPatchBytes = Math.max(0, retainedPatchBytes - pendingPatchBytes(pending))
      pendingPatches.delete(key)
    }
  }

  const trimStates = (): CodexStructuredItemStreamAdmission => {
    while (states.overCapacity) {
      const oldest = states.oldestEvictable()
      if (typeof oldest !== 'string') {
        break
      }
      const pending = coalescer.snapshot(oldest)
      if (pending && pending.text.length > 0) {
        const admission = persist(oldest, pending.text)
        if (!admission.accepted) {
          // The notification head still owns its incoming delta until capacity is admitted.
          return admission
        }
      }
      forgetState(oldest)
    }
    return { accepted: true }
  }

  const persist = (key: string, text: string): CodexStructuredItemStreamAdmission => {
    const state = states.get(key)
    if (!state) {
      return { accepted: false, reason: 'failed' }
    }
    const translated = codexStreamingJournalItem(state.item, text)
    if (translated.body) {
      const body = withJournalReasoningLifecycle(translated.body, { state: 'running' })
      const admission = appendCodexItemAndPublish(deps.sink, state.identity, body, {
        ...attributionOf(key),
        ...(state.startedAt === undefined ? {} : { observedAt: state.startedAt })
      })
      if (!admission.accepted) {
        return admission
      }
      acceptedAt.set(key, performance.now())
    }
    checkpointLengths.set(key, text.length)
    pendingCheckpoints.delete(key)
    if (pendingCheckpoints.size === 0) {
      checkpoints.cancel()
    }
    coalescer.markFlushed(key)
    return { accepted: true }
  }

  const coalescer = createAgentSessionDeltaCoalescer({
    windowMs: deps.coalesceMs,
    maxRetainedBytes: deps.maxRetainedBytes,
    maxTotalRetainedBytes: deps.maxTotalRetainedBytes,
    isProtected: (key) => states.isPersistent(key),
    schedule: deps.schedule,
    isCurrent: deps.isCurrent,
    onScheduledFailure: (admission) => checkpoints.fail(admission),
    shouldEmit: (key, length) => checkpoints.shouldPersist(key, length),
    emit: (key, text) => {
      const admission = persist(key, text)
      return states.get(key)?.item.type === 'plan' ? admission : admission.accepted
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
    const turnId = deps.turnIdFor(threadId, params)
    const state = { item, identity: deps.identityFor(threadId, turnId, item) }
    states.retain(key, state)
    producers.set(key, { threadId, turnId })
    return state
  }

  const flush = (threadId?: string): CodexStructuredItemStreamAdmission =>
    flushCodexItemStreamCheckpoints(
      {
        coalescer,
        pendingCheckpoints,
        producers,
        checkpointLengths,
        persist,
        typeFor: (key) => states.get(key)?.item.type,
        pendingPatches,
        flushPatch: (key) => checkpoints.flushPatch(key)
      },
      threadId
    )

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
        if (!streamFlushed.accepted && streamFlushed.reason !== 'backpressure') {
          return { handled: true, admission: streamFlushed }
        }
        const created = !states.get(key)
        const state = ensureState(threadId, itemId, 'fileChange', params)
        if (created) {
          const capacity = trimStates()
          if (!capacity.accepted) {
            forgetState(key)
            return { handled: true, admission: capacity }
          }
        }
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
            retainedPatchBytes - trimCodexPendingPatches(pendingPatches)
          )
          if (streamFlushed.accepted) {
            const admission = checkpoints.flushPatch(key)
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
      const key = codexStructuredItemKey(threadId, itemId)
      const created = !states.get(key)
      ensureState(threadId, itemId, type ?? 'reasoning', params)
      if (created) {
        const capacity = trimStates()
        if (!capacity.accepted) {
          // Retry a refused creation before accepting any incoming content.
          forgetState(key)
          return { handled: true, admission: capacity }
        }
      }
      const delta = method === REASONING_PART_METHOD ? '\n' : paramsRecord.delta
      if (typeof delta === 'string' && delta.length > 0) {
        // Save skipped full text before an incoming append evicts its buffer.
        const evicted = coalescer.evictionFor(key)
        const buffered = evicted === undefined ? null : coalescer.snapshot(evicted)
        if (
          evicted !== undefined &&
          buffered &&
          checkpointLengths.get(evicted) !== buffered.text.length
        ) {
          const admission = persist(evicted, buffered.text)
          if (!admission.accepted) {
            return { handled: true, admission }
          }
        }
        pendingCheckpoints.add(key)
        return { handled: true, admission: coalescer.append(key, delta) }
      }
      return { handled: true, admission: { accepted: true } }
    },
    forget: (threadId, itemId) => forgetState(codexStructuredItemKey(threadId, itemId)),
    flush,
    dispose: () => {
      checkpoints.cancel()
      coalescer.dispose()
      states.clear()
      checkpointLengths.clear()
      acceptedAt.clear()
      pendingCheckpoints.clear()
      producers.clear()
      pendingPatches.clear()
      retainedPatchBytes = 0
    },
    snapshot: (threadId, itemId) => coalescer.snapshot(codexStructuredItemKey(threadId, itemId))
  }
}
