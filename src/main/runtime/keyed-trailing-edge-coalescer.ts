/**
 * Per-key trailing-edge coalescing with a starvation cap.
 *
 * A burst of edges for one key collapses into a single `emit(key)` once the key has been quiet for
 * `flushMs`; under sustained churn the cap forces an emit every `maxWaitMs` so a key that never
 * goes quiet still makes progress. `emit` is expected to read the latest state itself, so the
 * intermediate edges it never sees carry no information.
 *
 * Extracted from the session.tabs notify coalescer so the orchestration redrive edge coalesces on
 * the same mechanism rather than a second timer layer with its own bugs. The windows stay per
 * caller: 50ms is right for a spinner-driven title, and much too tight for a journal stream.
 */

export type KeyedTrailingEdgeCoalescer = {
  /** Schedule a coalesced emit for a key. */
  schedule: (key: string) => void
  /** Drop a key's pending emit without firing. Use when it has been superseded or the key is gone. */
  cancel: (key: string) => void
  /** Fire a key's pending emit now, if it has one. */
  flush: (key: string) => void
  /** Fire every pending emit now. */
  flushAll: () => void
  /** Drop all pending state without emitting (teardown). */
  dispose: () => void
}

export type KeyedTrailingEdgeCoalescerOptions = {
  /** Quiet window before a coalesced emit fires. */
  flushMs: number
  /** Longest a key may be held back under sustained churn. */
  maxWaitMs: number
}

type PendingEmit = {
  timer: ReturnType<typeof setTimeout>
  firstScheduledAt: number
}

export function createKeyedTrailingEdgeCoalescer(
  emit: (key: string) => void,
  options: KeyedTrailingEdgeCoalescerOptions
): KeyedTrailingEdgeCoalescer {
  const pending = new Map<string, PendingEmit>()

  const clear = (key: string): void => {
    const entry = pending.get(key)
    if (!entry) {
      return
    }
    clearTimeout(entry.timer)
    pending.delete(key)
  }

  const fire = (key: string): void => {
    clear(key)
    emit(key)
  }

  const arm = (key: string): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(() => fire(key), options.flushMs)
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
    return timer
  }

  return {
    schedule(key: string): void {
      const now = Date.now()
      const existing = pending.get(key)
      if (existing) {
        // Cap total delay so sustained churn can't starve the emit forever.
        if (now - existing.firstScheduledAt >= options.maxWaitMs) {
          fire(key)
          return
        }
        clearTimeout(existing.timer)
        existing.timer = arm(key)
        return
      }
      pending.set(key, { timer: arm(key), firstScheduledAt: now })
    },
    cancel(key: string): void {
      clear(key)
    },
    flush(key: string): void {
      if (pending.has(key)) {
        fire(key)
      }
    },
    flushAll(): void {
      // Snapshot keys first: fire() deletes from `pending`, and emit may schedule new work, so
      // mutating the live map mid-iteration is unsafe.
      for (const key of Array.from(pending.keys())) {
        fire(key)
      }
    },
    dispose(): void {
      for (const entry of pending.values()) {
        clearTimeout(entry.timer)
      }
      pending.clear()
    }
  }
}
