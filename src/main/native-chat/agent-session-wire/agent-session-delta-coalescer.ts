// Coalesce token deltas into text snapshots to reduce journal writes and subscriber frames.
// Flush text before lifecycle events so completion/approval rows cannot overtake preceding text.

export const AGENT_SESSION_DELTA_COALESCE_MS = 60

/** Bound accumulated legal deltas independently of input record admission. */
export const AGENT_SESSION_STREAMED_TEXT_MAX_BYTES = 16 * 1024 * 1024
export const AGENT_SESSION_STREAMED_TEXT_TOTAL_MAX_BYTES = 32 * 1024 * 1024
export const AGENT_SESSION_STREAMED_TEXT_TRUNCATION_MARKER = '\n[Orca: streamed output truncated]'
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
    const text = stream.chunks.join('')
    const emitted = deps.emit(key, text, {
      text,
      observedBytes: stream.observedBytes,
      truncated: stream.truncated
    })
    if (emitted === false) {
      return false
    }
    stream.dirty = false
    return true
  }

  const scheduleFlush = (): void => {
    cancelTimer ??= schedule(() => {
      cancelTimer = null
      flushAll()
    }, windowMs)
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
      return true
    },
    flush: flushKey,
    flushAll,
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
        stream.dirty = false
      }
    }
  }
}

function appendWithinUtf8ByteLimit(
  current: string[],
  currentBytes: number,
  delta: string,
  deltaBytes: number,
  maxBytes: number
): { chunks: string[]; retainedBytes: number; truncated: boolean } {
  const available = Math.max(0, maxBytes - currentBytes)
  if (deltaBytes <= available) {
    // Append in place to avoid copying the entire prefix for every token.
    if (delta.length > 0) {
      current.push(delta)
    }
    return {
      chunks: current,
      retainedBytes: currentBytes + deltaBytes,
      truncated: false
    }
  }
  return truncateStreamPrefix(current, delta, maxBytes)
}

function truncateStreamPrefix(
  current: string[],
  delta: string,
  maxBytes: number
): { chunks: string[]; retainedBytes: number; truncated: boolean } {
  const marker = Buffer.from(AGENT_SESSION_STREAMED_TEXT_TRUNCATION_MARKER, 'utf8')
  const headBytes = Math.max(0, maxBytes - marker.byteLength)
  const boundedHead = Number.isSafeInteger(maxBytes) && maxBytes >= 0
  const combined = boundedHead
    ? Buffer.allocUnsafe(headBytes)
    : Buffer.concat([
        ...current.map((chunk) => Buffer.from(chunk, 'utf8')),
        Buffer.from(delta, 'utf8')
      ])
  let end = boundedHead
    ? writeStreamPrefix(combined, current, delta)
    : Math.min(combined.byteLength, headBytes)
  if (!boundedHead) {
    while (end > 0 && (combined[end] & 0b1100_0000) === 0b1000_0000) {
      end -= 1
    }
  }
  const visibleMarker = marker.subarray(0, Math.min(marker.byteLength, maxBytes - end))
  const text = combined.subarray(0, end).toString('utf8') + visibleMarker.toString('utf8')
  return {
    chunks: text ? [text] : [],
    retainedBytes: Buffer.byteLength(text, 'utf8'),
    truncated: true
  }
}

function writeStreamPrefix(buffer: Buffer, chunks: string[], delta: string): number {
  let end = 0
  for (const chunk of chunks) {
    if (end === buffer.length) {
      return end
    }
    const written = buffer.write(chunk, end, buffer.length - end, 'utf8')
    end += written
    // Independent chunk encoding preserves split-surrogate replacement.
    if (written < Buffer.byteLength(chunk, 'utf8')) {
      return end
    }
  }
  return end + buffer.write(delta, end, buffer.length - end, 'utf8')
}
