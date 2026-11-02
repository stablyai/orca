import { appendWithinUtf8ByteLimit } from './agent-session-delta-prefix'
import type { StructuredAgentSessionSinkAdmission } from './structured-agent-session-event-sink'

// Coalesce token deltas into text snapshots to reduce journal writes and subscriber frames.
// Flush text before lifecycle events so completion/approval rows cannot overtake preceding text.

export const AGENT_SESSION_DELTA_COALESCE_MS = 60
export const AGENT_SESSION_TEXT_CHECKPOINT_MS = 400

/** Bound accumulated legal deltas independently of input record admission. */
export const AGENT_SESSION_STREAMED_TEXT_MAX_BYTES = 16 * 1024 * 1024
export const AGENT_SESSION_STREAMED_TEXT_TOTAL_MAX_BYTES = 32 * 1024 * 1024
export { AGENT_SESSION_STREAMED_TEXT_TRUNCATION_MARKER } from './agent-session-delta-prefix'
export const AGENT_SESSION_MAX_STREAMS = 256

export type AgentSessionDeltaSnapshot = {
  text: string
  observedBytes: number
  truncated: boolean
}

export type AgentSessionDeltaCoalescerDeps = {
  /** Emit the complete snapshot, not the increment. */
  emit: (key: string, text: string, snapshot: AgentSessionDeltaSnapshot) => unknown
  /** False skips this delivery attempt and marks it clean; emit reports sink refusal. */
  shouldEmit?: (key: string, textLength: number) => boolean
  /** Only timer flushes check this; a skip keeps text for a later delta or barrier. */
  isDue?: (key: string) => boolean
  windowMs?: number
  maxRetainedBytes?: number
  maxTotalRetainedBytes?: number
  maxStreams?: number
  /** Caller byte-bounds protected metadata; only ordinary streams use the count cap. */
  isProtected?: (key: string) => boolean
  schedule?: (run: () => void, ms: number) => () => void
  isCurrent?: () => boolean
  onScheduledFailure?: (
    admission: StructuredAgentSessionSinkAdmission & { accepted: false }
  ) => void
}

export type AgentSessionDeltaCoalescer = {
  /** Refusal leaves the incoming delta unconsumed. */
  append: (key: string, delta: string) => StructuredAgentSessionSinkAdmission
  /** Return the buffer the next nonempty append would evict, without changing it. */
  evictionFor: (key: string) => string | undefined
  flush: (key: string) => StructuredAgentSessionSinkAdmission
  /** Lifecycle barriers flush every stream first. */
  flushAll: () => StructuredAgentSessionSinkAdmission
  /** Authoritative bodies supersede buffered text; drop it without emission. */
  forget: (key: string) => void
  dispose: () => void
  snapshot: (key: string) => AgentSessionDeltaSnapshot | null
  dirty: (
    select?: (key: string) => boolean
  ) => { key: string; snapshot: AgentSessionDeltaSnapshot }[]
  /** External writes satisfy the current snapshot until more text arrives. */
  markFlushed: (key: string) => void
}

export function scheduleAgentSessionDeltaFlush(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms)
  timer.unref?.()
  return () => clearTimeout(timer)
}

export function createAgentSessionDeltaCoalescer(
  deps: AgentSessionDeltaCoalescerDeps
): AgentSessionDeltaCoalescer {
  const windowMs = deps.windowMs ?? AGENT_SESSION_DELTA_COALESCE_MS
  const schedule = deps.schedule ?? scheduleAgentSessionDeltaFlush
  const maxRetainedBytes = deps.maxRetainedBytes ?? AGENT_SESSION_STREAMED_TEXT_MAX_BYTES
  const maxTotalRetainedBytes =
    deps.maxTotalRetainedBytes ?? AGENT_SESSION_STREAMED_TEXT_TOTAL_MAX_BYTES
  const maxStreams = Math.max(1, deps.maxStreams ?? AGENT_SESSION_MAX_STREAMS)
  const streams = new Map<
    string,
    {
      chunks: string[]
      retainedBytes: number
      textLength: number
      observedBytes: number
      truncated: boolean
      dirty: boolean
    }
  >()
  let totalRetainedBytes = 0
  let cancelTimer: (() => void) | null = null
  const evictable = new Set<string>()

  const flushKey = (key: string): StructuredAgentSessionSinkAdmission => {
    const stream = streams.get(key)
    if (!stream?.dirty) {
      return { accepted: true }
    }
    if (deps.shouldEmit?.(key, stream.textLength) === false) {
      stream.dirty = false
      return { accepted: true }
    }
    const text = stream.chunks.join('')
    const emitted = normalizeAdmission(
      deps.emit(key, text, {
        text,
        observedBytes: stream.observedBytes,
        truncated: stream.truncated
      })
    )
    if (!emitted.accepted) {
      return emitted
    }
    stream.dirty = false
    return emitted
  }

  const scheduleFlush = (): void => {
    cancelTimer ??= schedule(() => {
      cancelTimer = null
      if (deps.isCurrent?.() === false) {
        return
      }
      const admission = flushAll(true)
      if (!admission.accepted && admission.reason !== 'backpressure') {
        deps.onScheduledFailure?.(admission)
      }
    }, windowMs)
  }

  const flushAll = (scheduled = false): StructuredAgentSessionSinkAdmission => {
    cancelTimer?.()
    cancelTimer = null
    let emitted: StructuredAgentSessionSinkAdmission = { accepted: true }
    for (const [key, stream] of streams) {
      if (scheduled && stream.dirty && deps.isDue?.(key) === false) {
        continue
      }
      const admission = flushKey(key)
      if (!admission.accepted) {
        emitted = admission
        if (admission.reason !== 'backpressure') {
          break
        }
      }
    }
    if (!emitted.accepted && emitted.reason === 'backpressure') {
      scheduleFlush()
    }
    return emitted
  }

  return {
    append: (key, delta) => {
      if (delta.length === 0) {
        return { accepted: true }
      }
      let stream = streams.get(key)
      if (!stream) {
        // Flush before eviction so a new untrusted ID cannot erase observed output.
        while (!deps.isProtected?.(key) && evictable.size >= maxStreams) {
          const oldest = evictable.values().next().value
          if (oldest) {
            if (deps.isProtected?.(oldest)) {
              evictable.delete(oldest)
              continue
            }
            // Backpressure must retain observed text for retry.
            const admission = flushKey(oldest)
            if (!admission.accepted) {
              return admission
            }
            const evicted = streams.get(oldest)
            if (evicted) {
              totalRetainedBytes -= evicted.retainedBytes
            }
            streams.delete(oldest)
            evictable.delete(oldest)
          }
          break
        }
        stream = {
          chunks: [],
          retainedBytes: 0,
          textLength: 0,
          observedBytes: 0,
          truncated: false,
          dirty: false
        }
        if (!deps.isProtected?.(key)) {
          evictable.add(key)
        }
      } else if (deps.isProtected?.(key)) {
        evictable.delete(key)
      }
      const deltaBytes = Buffer.byteLength(delta, 'utf8')
      stream.observedBytes += deltaBytes
      if (!stream.truncated) {
        const availableTotal = Math.max(0, maxTotalRetainedBytes - totalRetainedBytes)
        const streamLimit = Math.min(maxRetainedBytes, stream.retainedBytes + availableTotal)
        const next = appendWithinUtf8ByteLimit(
          stream.chunks,
          stream.retainedBytes,
          delta,
          deltaBytes,
          streamLimit
        )
        totalRetainedBytes += next.retainedBytes - stream.retainedBytes
        stream.textLength = next.truncated
          ? (next.chunks[0]?.length ?? 0)
          : stream.textLength + delta.length
        stream.chunks = next.chunks
        stream.retainedBytes = next.retainedBytes
        stream.truncated = next.truncated
        stream.dirty = true
      }
      streams.set(key, stream)
      // Share one timer across streams to bound wakeups per window.
      scheduleFlush()
      return { accepted: true }
    },
    evictionFor: (key) => {
      if (streams.has(key) || deps.isProtected?.(key) || evictable.size < maxStreams) {
        return undefined
      }
      let remaining = evictable.size
      for (const oldest of evictable) {
        if (remaining < maxStreams) {
          return undefined
        }
        if (!deps.isProtected?.(oldest)) {
          return oldest || undefined
        }
        remaining -= 1
      }
      return undefined
    },
    flush: flushKey,
    flushAll: () => flushAll(),
    forget: (key) => {
      const stream = streams.get(key)
      if (stream) {
        totalRetainedBytes -= stream.retainedBytes
        streams.delete(key)
        evictable.delete(key)
      }
    },
    dispose: () => {
      cancelTimer?.()
      cancelTimer = null
      streams.clear()
      evictable.clear()
      totalRetainedBytes = 0
    },
    snapshot: (key) => {
      const stream = streams.get(key)
      return stream
        ? {
            text: stream.chunks.join(''),
            observedBytes: stream.observedBytes,
            truncated: stream.truncated
          }
        : null
    },
    dirty: (select) =>
      [...streams].flatMap(([key, stream]) =>
        stream.dirty && (select?.(key) ?? true)
          ? [
              {
                key,
                snapshot: {
                  text: stream.chunks.join(''),
                  observedBytes: stream.observedBytes,
                  truncated: stream.truncated
                }
              }
            ]
          : []
      ),
    markFlushed: (key) => {
      const stream = streams.get(key)
      if (stream) {
        stream.dirty = false
      }
    }
  }
}

function isAdmission(value: unknown): value is StructuredAgentSessionSinkAdmission {
  if (typeof value === 'object' && value !== null && 'accepted' in value) {
    if (value.accepted === true) {
      return true
    }
    if (
      value.accepted === false &&
      'reason' in value &&
      (value.reason === 'backpressure' || value.reason === 'failed' || value.reason === 'closed')
    ) {
      return true
    }
  }
  return false
}

function normalizeAdmission(value: unknown): StructuredAgentSessionSinkAdmission {
  return isAdmission(value)
    ? value
    : value === false
      ? { accepted: false, reason: 'backpressure' }
      : { accepted: true }
}
