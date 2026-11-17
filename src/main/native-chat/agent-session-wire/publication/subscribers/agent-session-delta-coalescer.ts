import { appendWithinUtf8ByteLimit } from './agent-session-delta-prefix'

// Coalesce token deltas into text snapshots to reduce journal writes and subscriber frames.
// Flush text before lifecycle events so completion/approval rows cannot overtake preceding text.

export const AGENT_SESSION_DELTA_COALESCE_MS = 60
export const AGENT_SESSION_TEXT_CHECKPOINT_MS = 400

export function agentSessionTextCheckpointDueIn(savedAt: number | undefined): number {
  return savedAt === undefined
    ? 0
    : Math.max(0, AGENT_SESSION_TEXT_CHECKPOINT_MS - (performance.now() - savedAt))
}

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
  /** False skips an accepted snapshot; emit reports actual sink refusal. */
  shouldEmit?: (key: string, textLength: number) => boolean
  /** Delay timed saves without delaying lifecycle barriers or joining buffered text. */
  dueIn?: (key: string) => number
  windowMs?: number
  maxRetainedBytes?: number
  maxTotalRetainedBytes?: number
  maxStreams?: number
  /** Caller byte-bounds protected metadata; only ordinary streams use the count cap. */
  isProtected?: (key: string) => boolean
  schedule?: (run: () => void, ms: number) => () => void
}

export type AgentSessionDeltaCoalescer = {
  /** False means a retained stream could not flush to admit this key. */
  append: (key: string, delta: string) => boolean
  flush: (key: string) => boolean
  /** Lifecycle barriers flush every stream first. */
  flushAll: (only?: (key: string) => boolean) => boolean
  /** Authoritative bodies supersede buffered text; drop it without emission. */
  forget: (key: string) => void
  dispose: () => void
  snapshot: (key: string) => AgentSessionDeltaSnapshot | null
  dirty: () => { key: string; snapshot: AgentSessionDeltaSnapshot }[]
  /** External writes satisfy the current snapshot until more text arrives. */
  markFlushed: (key: string) => void
}

function defaultSchedule(run: () => void, ms: number): () => void {
  const timer = setTimeout(run, ms)
  timer.unref?.()
  return () => clearTimeout(timer)
}

export function createAgentSessionDeltaCoalescer(
  deps: AgentSessionDeltaCoalescerDeps
): AgentSessionDeltaCoalescer {
  const windowMs = deps.windowMs ?? AGENT_SESSION_DELTA_COALESCE_MS
  const schedule = deps.schedule ?? defaultSchedule
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
      cancelTimer: (() => void) | null
    }
  >()
  let totalRetainedBytes = 0
  const evictable = new Set<string>()
  const batched = new Set<string>()
  let cancelBatch: (() => void) | null = null

  const flushKey = (key: string): boolean => {
    const stream = streams.get(key)
    if (!stream?.dirty) {
      return true
    }
    stream.cancelTimer?.()
    stream.cancelTimer = null
    batched.delete(key)
    if (deps.shouldEmit?.(key, stream.textLength) === false) {
      stream.dirty = false
      return true
    }
    const text = stream.chunks.join('')
    const emitted = deps.emit(key, text, {
      text,
      observedBytes: stream.observedBytes,
      truncated: stream.truncated
    })
    if (emitted === false) {
      scheduleFlush(key)
      return false
    }
    stream.dirty = false
    return true
  }

  const scheduleFlush = (key: string, minimumMs = windowMs): void => {
    const stream = streams.get(key)
    if (!stream?.dirty || stream.cancelTimer) {
      return
    }
    if (!deps.dueIn) {
      batched.add(key)
      cancelBatch ??= schedule(() => {
        cancelBatch = null
        const pending = [...batched]
        batched.clear()
        for (const id of pending) {
          flushKey(id)
        }
      }, windowMs)
      return
    }
    stream.cancelTimer = schedule(
      () => {
        stream.cancelTimer = null
        if (streams.get(key) !== stream || !stream.dirty) {
          return
        }
        if ((deps.dueIn?.(key) ?? 0) > 0) {
          scheduleFlush(key, 1)
        } else if (!flushKey(key)) {
          scheduleFlush(key)
        }
      },
      Math.max(minimumMs, deps.dueIn?.(key) ?? 0)
    )
  }

  const flushAll = (only?: (key: string) => boolean): boolean => {
    let emitted = true
    for (const key of streams.keys()) {
      if ((!only || only(key)) && !flushKey(key)) {
        scheduleFlush(key)
        emitted = false
      }
    }
    return emitted
  }

  return {
    append: (key, delta) => {
      if (delta.length === 0) {
        return true
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
            if (!flushKey(oldest)) {
              return false
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
          dirty: false,
          cancelTimer: null
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
      // Each dirty stream owns its deadline; a wake never scans unrelated streams.
      scheduleFlush(key)
      return true
    },
    flush: flushKey,
    flushAll,
    forget: (key) => {
      const stream = streams.get(key)
      if (stream) {
        stream.cancelTimer?.()
        batched.delete(key)
        totalRetainedBytes -= stream.retainedBytes
        streams.delete(key)
        evictable.delete(key)
      }
    },
    dispose: () => {
      for (const stream of streams.values()) {
        stream.cancelTimer?.()
      }
      cancelBatch?.()
      cancelBatch = null
      batched.clear()
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
    dirty: () =>
      [...streams].flatMap(([key, stream]) =>
        stream.dirty
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
        stream.cancelTimer?.()
        stream.cancelTimer = null
        batched.delete(key)
        stream.dirty = false
      }
    }
  }
}
