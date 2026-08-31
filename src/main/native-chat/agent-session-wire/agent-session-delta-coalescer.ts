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

export type AgentSessionDeltaCoalescerDeps = {
  /** Called with the FULL text accumulated for the key, not the increment. */
  emit: (key: string, text: string) => void
  windowMs?: number
  /** Injected by tests so a window can be driven without real time. */
  schedule?: (run: () => void, ms: number) => () => void
}

export type AgentSessionDeltaCoalescer = {
  append: (key: string, delta: string) => void
  /** Emit one stream now, if it has unflushed text. */
  flush: (key: string) => void
  /** Emit every stream now. The lifecycle bypass. */
  flushAll: () => void
  /** Drop a stream without emitting — its authoritative body arrived, so the
   *  accumulated text is now the stale copy. */
  forget: (key: string) => void
  dispose: () => void
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
  const streams = new Map<string, { text: string; dirty: boolean }>()
  let cancelTimer: (() => void) | null = null

  const flushKey = (key: string): void => {
    const stream = streams.get(key)
    if (!stream?.dirty) {
      return
    }
    stream.dirty = false
    deps.emit(key, stream.text)
  }

  const flushAll = (): void => {
    cancelTimer?.()
    cancelTimer = null
    for (const key of streams.keys()) {
      flushKey(key)
    }
  }

  return {
    append: (key, delta) => {
      const stream = streams.get(key) ?? { text: '', dirty: false }
      stream.text += delta
      stream.dirty = true
      streams.set(key, stream)
      // One timer for every stream: a shared deadline bounds latency the same
      // way and costs one wakeup per window instead of one per stream.
      cancelTimer ??= schedule(() => {
        cancelTimer = null
        flushAll()
      }, windowMs)
    },
    flush: flushKey,
    flushAll,
    forget: (key) => {
      streams.delete(key)
    },
    dispose: () => {
      cancelTimer?.()
      cancelTimer = null
      streams.clear()
    }
  }
}
