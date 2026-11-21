import { appendWithinUtf8ByteLimit } from './agent-session-delta-prefix'

// Coalesce token deltas into text snapshots to reduce journal writes and subscriber frames.
// Flush text before lifecycle events so completion/approval rows cannot overtake preceding text.

export const AGENT_SESSION_DELTA_COALESCE_MS = 60
/** Quiet time after the last delta before a stream's unsaved text is saved. */
export const AGENT_SESSION_TEXT_IDLE_SAVE_MS = 1000

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

/** What `emit` returns when it took the snapshot without saving it (only shown it live). */
export const AGENT_SESSION_DELTA_SHOWN_ONLY = 'shown-only'

export type AgentSessionDeltaCoalescerDeps = {
  /** Emit the complete snapshot, not the increment. */
  emit: (key: string, text: string, snapshot: AgentSessionDeltaSnapshot) => unknown
  /** False skips an accepted snapshot; emit reports actual sink refusal. */
  shouldEmit?: (key: string, textLength: number) => boolean
  /** Runs once a stream `applies` to has had no text for `ms`; each later quiet save of that stream
   *  needs twice the quiet, so however sparse its deltas a stream gets only logarithmically many. */
  idle?: {
    ms: number
    applies?: (key: string) => boolean
    run: (key: string, text: string) => void
  }
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
  flushAll: () => boolean
  /** Authoritative bodies supersede buffered text; drop it without emission. */
  forget: (key: string) => void
  dispose: () => void
  snapshot: (key: string) => AgentSessionDeltaSnapshot | null
  /** The retained text, or undefined past `maxLength`; a longer text is never joined. */
  textWithin: (key: string, maxLength: number) => string | undefined
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
      appendedAt: number
      quietMs: number
      cancelIdle: (() => void) | null
    }
  >()
  let totalRetainedBytes = 0
  let cancelTimer: (() => void) | null = null
  const evictable = new Set<string>()

  const flushKey = (key: string): boolean => {
    const stream = streams.get(key)
    if (!stream?.dirty) {
      return true
    }
    if (deps.shouldEmit?.(key, stream.textLength) === false) {
      stream.dirty = false
      return true
    }
    const text = joined(stream)
    const emitted = deps.emit(key, text, {
      text,
      observedBytes: stream.observedBytes,
      truncated: stream.truncated
    })
    if (emitted === false) {
      return false
    }
    stream.dirty = false
    // A save starts the quiet-save backoff over, so the next pause still saves within a second.
    if (emitted !== AGENT_SESSION_DELTA_SHOWN_ONLY) {
      stream.quietMs = deps.idle?.ms ?? 0
    }
    return true
  }

  const scheduleFlush = (): void => {
    cancelTimer ??= schedule(() => {
      cancelTimer = null
      flushAll()
    }, windowMs)
  }

  type Stream = NonNullable<ReturnType<typeof streams.get>>
  // Keep the joined text so rereading an unchanged stream copies nothing.
  const joined = (stream: Stream): string => {
    const text = stream.chunks.length === 1 ? stream.chunks[0] : stream.chunks.join('')
    stream.chunks = text ? [text] : []
    return text
  }

  // Measured from the last delta, never the last save, so continuous streaming saves nothing extra.
  const armIdle = (key: string, stream: Stream, ms: number): void => {
    const idle = deps.idle
    if (!idle) {
      return
    }
    stream.cancelIdle = schedule(() => {
      stream.cancelIdle = null
      if (streams.get(key) !== stream) {
        return
      }
      const quiet = performance.now() - stream.appendedAt
      if (quiet < stream.quietMs) {
        armIdle(key, stream, stream.quietMs - quiet)
        return
      }
      stream.quietMs *= 2
      idle.run(key, joined(stream))
    }, ms)
  }

  const flushAll = (): boolean => {
    cancelTimer?.()
    cancelTimer = null
    let emitted = true
    for (const key of streams.keys()) {
      emitted = flushKey(key) && emitted
    }
    if (!emitted) {
      scheduleFlush()
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
              evicted.cancelIdle?.()
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
          appendedAt: 0,
          quietMs: deps.idle?.ms ?? 0,
          cancelIdle: null
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
      stream.appendedAt = performance.now()
      if (!stream.cancelIdle && deps.idle?.applies?.(key) !== false) {
        armIdle(key, stream, stream.quietMs)
      }
      // Share one timer across streams to bound wakeups per window.
      scheduleFlush()
      return true
    },
    flush: flushKey,
    flushAll,
    forget: (key) => {
      const stream = streams.get(key)
      if (stream) {
        stream.cancelIdle?.()
        totalRetainedBytes -= stream.retainedBytes
        streams.delete(key)
        evictable.delete(key)
      }
    },
    dispose: () => {
      cancelTimer?.()
      cancelTimer = null
      for (const stream of streams.values()) {
        stream.cancelIdle?.()
      }
      streams.clear()
      evictable.clear()
      totalRetainedBytes = 0
    },
    textWithin: (key, maxLength) => {
      const stream = streams.get(key)
      return stream && stream.textLength <= maxLength ? joined(stream) : undefined
    },
    snapshot: (key) => {
      const stream = streams.get(key)
      return stream
        ? {
            text: joined(stream),
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
                  text: joined(stream),
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
