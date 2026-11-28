/** Coalesce each key until quiet, with a maximum delay under sustained churn.
 * emit reads current state; callers choose windows appropriate to their stream. */

export type KeyedTrailingEdgeCoalescer = {
  schedule: (key: string) => void
  cancel: (key: string) => void
  flush: (key: string) => void
  flushAll: () => void
  dispose: () => void
}

export type KeyedTrailingEdgeCoalescerOptions = {
  flushMs: number
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

  const arm = (key: string, remainingMs: number): ReturnType<typeof setTimeout> => {
    const timer = setTimeout(() => fire(key), Math.min(options.flushMs, remainingMs))
    if (typeof timer.unref === 'function') {
      timer.unref()
    }
    return timer
  }

  return {
    schedule(key: string): void {
      // Monotonic so a wall-clock change cannot move the maxWaitMs deadline.
      const now = performance.now()
      const existing = pending.get(key)
      if (existing) {
        const remainingMs = options.maxWaitMs - (now - existing.firstScheduledAt)
        if (remainingMs <= 0) {
          fire(key)
          return
        }
        clearTimeout(existing.timer)
        existing.timer = arm(key, remainingMs)
        return
      }
      pending.set(key, { timer: arm(key, options.maxWaitMs), firstScheduledAt: now })
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
      // Snapshot keys: emit can schedule new work while fire deletes pending entries.
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
