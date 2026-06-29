export type RendererRecoveryEventName =
  | 'renderer_recovery_scheduled'
  | 'renderer_recovery_suppressed'
  | 'renderer_recovery_stable'

export type RendererRecoverySummary = {
  totalProcessGoneCount: number
  recentProcessGoneCount: number
  suppressedRecoveryCount: number
  lastReason: string
  lastExitCode: number | null
  degradedUntil: number | null
  degraded: boolean
}

export type RendererRecoveryGuardOptions = {
  loopWindowMs?: number
  maxAutomaticRecoveries?: number
  cooldownMs?: number
  stableLoadMs?: number
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => NodeJS.Timeout
  clearTimer?: (timer: NodeJS.Timeout) => void
  onEvent?: (name: RendererRecoveryEventName, summary: RendererRecoverySummary) => void
}

export const RECOVERY_LOOP_WINDOW_MS = 60_000
export const MAX_AUTOMATIC_RECOVERIES_PER_WINDOW = 2
export const RECOVERY_COOLDOWN_MS = 5 * 60_000
export const STABLE_LOAD_MS = 30_000

export type RendererRecoveryGuard = ReturnType<typeof createRendererRecoveryGuard>

const EMPTY_LAST_REASON = 'none'

function cloneSummary(summary: RendererRecoverySummary): RendererRecoverySummary {
  return { ...summary }
}

export function createRendererRecoveryGuard(options: RendererRecoveryGuardOptions = {}) {
  const loopWindowMs = options.loopWindowMs ?? RECOVERY_LOOP_WINDOW_MS
  const maxAutomaticRecoveries =
    options.maxAutomaticRecoveries ?? MAX_AUTOMATIC_RECOVERIES_PER_WINDOW
  const cooldownMs = options.cooldownMs ?? RECOVERY_COOLDOWN_MS
  const stableLoadMs = options.stableLoadMs ?? STABLE_LOAD_MS
  const now = options.now ?? Date.now
  const setTimer =
    options.setTimer ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs))
  const clearTimer = options.clearTimer ?? clearTimeout

  let stableLoadTimer: NodeJS.Timeout | null = null
  let disposed = false
  let totalProcessGoneCount = 0
  let suppressedRecoveryCount = 0
  let processGoneTimes: number[] = []
  let lastReason = EMPTY_LAST_REASON
  let lastExitCode: number | null = null
  let degradedUntil: number | null = null

  const clearStableLoadTimer = (): void => {
    if (stableLoadTimer) {
      clearTimer(stableLoadTimer)
      stableLoadTimer = null
    }
  }

  const pruneRecentProcessGoneTimes = (timestamp: number): void => {
    processGoneTimes = processGoneTimes.filter((seenAt) => timestamp - seenAt <= loopWindowMs)
  }

  const getSummary = (timestamp = now()): RendererRecoverySummary => {
    pruneRecentProcessGoneTimes(timestamp)
    const degraded = degradedUntil !== null && timestamp < degradedUntil
    return {
      totalProcessGoneCount,
      recentProcessGoneCount: processGoneTimes.length,
      suppressedRecoveryCount,
      lastReason,
      lastExitCode,
      degradedUntil,
      degraded
    }
  }

  const emit = (name: RendererRecoveryEventName, timestamp = now()): void => {
    options.onEvent?.(name, cloneSummary(getSummary(timestamp)))
  }

  return {
    recordProcessGone(details: {
      reason: string
      exitCode?: number | null
    }): RendererRecoverySummary {
      const timestamp = now()
      clearStableLoadTimer()
      pruneRecentProcessGoneTimes(timestamp)
      totalProcessGoneCount += 1
      processGoneTimes.push(timestamp)
      lastReason = details.reason
      lastExitCode = details.exitCode ?? null
      return cloneSummary(getSummary(timestamp))
    },

    canScheduleAutomaticRecovery(): { allowed: boolean; summary: RendererRecoverySummary } {
      const timestamp = now()
      const summary = getSummary(timestamp)
      if (summary.degraded || summary.recentProcessGoneCount > maxAutomaticRecoveries) {
        if (!summary.degraded) {
          degradedUntil = timestamp + cooldownMs
        }
        suppressedRecoveryCount += 1
        const suppressedSummary = cloneSummary(getSummary(timestamp))
        emit('renderer_recovery_suppressed', timestamp)
        return { allowed: false, summary: suppressedSummary }
      }
      emit('renderer_recovery_scheduled', timestamp)
      return { allowed: true, summary: cloneSummary(summary) }
    },

    onStableLoad(): void {
      if (disposed) {
        return
      }
      clearStableLoadTimer()
      const hadRecoveryState = processGoneTimes.length > 0 || degradedUntil !== null
      stableLoadTimer = setTimer(() => {
        stableLoadTimer = null
        if (disposed) {
          return
        }
        processGoneTimes = []
        degradedUntil = null
        if (hadRecoveryState) {
          emit('renderer_recovery_stable')
        }
      }, stableLoadMs)
    },

    getSummary(): RendererRecoverySummary {
      return cloneSummary(getSummary())
    },

    dispose(): void {
      disposed = true
      clearStableLoadTimer()
    }
  }
}
