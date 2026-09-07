// Server-side coalescing for streamed assistant text.
//
// Providers emit one notification per token. Journaling each one would write a
// row and wake every subscriber per token, so a single long answer costs
// thousands of appends and thousands of stream frames on a phone. Deltas are
// therefore accumulated and flushed on a short window; the journal row is a
// SNAPSHOT of the text so far, which is also what makes dropping intermediate
// frames safe for a reconnecting client.
//
// The window applies to text only. Lifecycle — an item completing, a turn
// ending, an approval arriving — bypasses it by flushing first, so nothing can
// be journaled ahead of the text that preceded it.

/** Long enough to fold a burst of tokens into one row, short enough that the
 *  text still reads as streaming. */
export const AGENT_SESSION_DELTA_COALESCE_MS = 60

/** Matches the admitted live provider-record envelope. The framer owns record
 * admission; this independently prevents many legal deltas from rebuilding an
 * unbounded string after they have crossed that boundary. */
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
  /** Called with the FULL text accumulated for the key, not the increment. */
  emit: (key: string, text: string, snapshot: AgentSessionDeltaSnapshot) => unknown
  windowMs?: number
  maxRetainedBytes?: number
  maxTotalRetainedBytes?: number
  /** Maximum distinct item streams retained at once. */
  maxStreams?: number
  /** Injected by tests so a window can be driven without real time. */
  schedule?: (run: () => void, ms: number) => () => void
}

export type AgentSessionDeltaCoalescer = {
  /** Returns false when a full stream cannot be flushed to admit this new key. */
  append: (key: string, delta: string) => boolean
  /** Emit one stream now, if it has unflushed text. */
  flush: (key: string) => boolean
  /** Emit every stream now. The lifecycle bypass. */
  flushAll: () => boolean
  /** Drop a stream without emitting — its authoritative body arrived, so the
   *  accumulated text is now the stale copy. */
  forget: (key: string) => void
  dispose: () => void
  /** Bounded last-known state for terminalizing a rejected completion. */
  snapshot: (key: string) => AgentSessionDeltaSnapshot | null
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
      observedBytes: number
      truncated: boolean
      dirty: boolean
    }
  >()
  let totalRetainedBytes = 0
  let cancelTimer: (() => void) | null = null
  const streamOrder = new Map<string, number>()
  let nextOrder = 0

  const flushKey = (key: string): boolean => {
    const stream = streams.get(key)
    if (!stream?.dirty) {
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
        // Evict the oldest stream before admitting a new attacker-controlled
        // id. Flush first so the retained prefix is durably visible.
        if (streams.size >= maxStreams) {
          const oldest = [...streamOrder.entries()].sort((a, b) => a[1] - b[1])[0]?.[0]
          if (oldest) {
            // Under sink backpressure the oldest stream must remain available
            // for a later retry; dropping it would lose already-observed output.
            if (!flushKey(oldest)) {
              return false
            }
            const evicted = streams.get(oldest)
            if (evicted) {
              totalRetainedBytes -= evicted.retainedBytes
            }
            streams.delete(oldest)
            streamOrder.delete(oldest)
          }
        }
        stream = {
          chunks: [],
          retainedBytes: 0,
          observedBytes: 0,
          truncated: false,
          dirty: false
        }
        streamOrder.set(key, nextOrder++)
      }
      stream.observedBytes += Buffer.byteLength(delta, 'utf8')
      if (!stream.truncated) {
        const availableTotal = Math.max(0, maxTotalRetainedBytes - totalRetainedBytes)
        const streamLimit = Math.min(maxRetainedBytes, stream.retainedBytes + availableTotal)
        const next = appendWithinUtf8ByteLimit(
          stream.chunks,
          stream.retainedBytes,
          delta,
          streamLimit
        )
        totalRetainedBytes += next.retainedBytes - stream.retainedBytes
        stream.chunks = next.chunks
        stream.retainedBytes = next.retainedBytes
        stream.truncated = next.truncated
        stream.dirty = true
      }
      streams.set(key, stream)
      // One timer for every stream: a shared deadline bounds latency the same
      // way and costs one wakeup per window instead of one per stream.
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
        streamOrder.delete(key)
      }
    },
    dispose: () => {
      cancelTimer?.()
      cancelTimer = null
      streams.clear()
      streamOrder.clear()
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
    }
  }
}

function appendWithinUtf8ByteLimit(
  current: string[],
  currentBytes: number,
  delta: string,
  maxBytes: number
): { chunks: string[]; retainedBytes: number; truncated: boolean } {
  const available = Math.max(0, maxBytes - currentBytes)
  const deltaBuffer = Buffer.from(delta, 'utf8')
  if (deltaBuffer.byteLength <= available) {
    // The caller owns the per-stream array; append in place so each token is
    // amortized O(1) instead of copying the complete prefix on every delta.
    current.push(delta)
    return {
      chunks: current,
      retainedBytes: currentBytes + deltaBuffer.byteLength,
      truncated: false
    }
  }
  const marker = Buffer.from(AGENT_SESSION_STREAMED_TEXT_TRUNCATION_MARKER, 'utf8')
  const headBytes = Math.max(0, maxBytes - marker.byteLength)
  const combined = Buffer.concat([
    ...current.map((chunk) => Buffer.from(chunk, 'utf8')),
    deltaBuffer
  ])
  let end = Math.min(combined.byteLength, headBytes)
  while (end > 0 && (combined[end] & 0b1100_0000) === 0b1000_0000) {
    end -= 1
  }
  const visibleMarker = marker.subarray(0, Math.min(marker.byteLength, maxBytes - end))
  const text = combined.subarray(0, end).toString('utf8') + visibleMarker.toString('utf8')
  return {
    chunks: text ? [text] : [],
    retainedBytes: Buffer.byteLength(text, 'utf8'),
    truncated: true
  }
}
