const DEFAULT_DEBOUNCE_MS = 40
const EVENT_DRAIN_MAX_WAIT_MS = 250
const DEFAULT_RECONCILIATION_MS = 1_000

type TranscriptWatchSchedulerOptions = {
  debounceMs?: number
  reconciliationIntervalMs?: number
  drain: () => void
  reconcile: () => Promise<void>
}

export type TranscriptWatchScheduler = {
  scheduleEventDrain: () => void
  scheduleRetry: (delayMs: number) => boolean
  startReconciliation: () => void
  dispose: () => void
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  timer.unref?.()
}

export function createTranscriptWatchScheduler(
  options: TranscriptWatchSchedulerOptions
): TranscriptWatchScheduler {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const maxEventWaitMs = Math.max(debounceMs, EVENT_DRAIN_MAX_WAIT_MS)
  const reconciliationIntervalMs = options.reconciliationIntervalMs ?? DEFAULT_RECONCILIATION_MS
  let disposed = false
  let drainTimer: ReturnType<typeof setTimeout> | null = null
  let firstEventAt: number | null = null
  let reconciliationTimer: ReturnType<typeof setTimeout> | null = null

  function clearDrainTimer(): void {
    if (!drainTimer) {
      return
    }
    clearTimeout(drainTimer)
    drainTimer = null
  }

  function fireDrain(): void {
    clearDrainTimer()
    firstEventAt = null
    options.drain()
  }

  function armDrain(delayMs: number): void {
    drainTimer = setTimeout(fireDrain, delayMs)
    unrefTimer(drainTimer)
  }

  function armReconciliation(): void {
    if (disposed || reconciliationTimer) {
      return
    }
    reconciliationTimer = setTimeout(() => {
      reconciliationTimer = null
      // Why: wait for the host-side stat/drain check before rearming so a slow
      // remote filesystem cannot accumulate overlapping reconciliation work.
      void options.reconcile().then(armReconciliation, armReconciliation)
    }, reconciliationIntervalMs)
    unrefTimer(reconciliationTimer)
  }

  return {
    scheduleEventDrain(): void {
      if (disposed) {
        return
      }
      const now = Date.now()
      firstEventAt ??= now
      const remainingMaxWait = Math.max(0, maxEventWaitMs - (now - firstEventAt))
      clearDrainTimer()
      armDrain(Math.min(debounceMs, remainingMaxWait))
    },
    scheduleRetry(delayMs: number): boolean {
      if (disposed || drainTimer) {
        return false
      }
      firstEventAt = null
      armDrain(delayMs)
      return true
    },
    startReconciliation(): void {
      armReconciliation()
    },
    dispose(): void {
      if (disposed) {
        return
      }
      disposed = true
      clearDrainTimer()
      if (reconciliationTimer) {
        clearTimeout(reconciliationTimer)
        reconciliationTimer = null
      }
      firstEventAt = null
    }
  }
}
