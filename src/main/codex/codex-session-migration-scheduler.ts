import type { CodexSessionBackfillOptions } from './codex-session-backfill-types'

type MigrationRun = (
  options: CodexSessionBackfillOptions,
  systemCodexHomePathOverride?: string
) => Promise<unknown>

export type CodexSessionMigrationScheduler = {
  scheduleInitialRun(): void
  requestRun(): void
}

export function createCodexSessionMigrationScheduler(args: {
  isEligible: () => boolean
  isQuitting: () => boolean
  resolveSystemCodexHomePathOverride: () => string | undefined
  startBackfill: MigrationRun
  startIndexHeal: MigrationRun
  initialDelayMs?: number
}): CodexSessionMigrationScheduler {
  let initialTimer: ReturnType<typeof setTimeout> | null = null
  let migrationTask: Promise<void> | null = null
  let activeRunStopObserved = false
  let rerunRequested = false

  const requestRun = (): void => {
    if (args.isQuitting() || !args.isEligible()) {
      return
    }
    if (migrationTask) {
      // Why: an account transition can re-enable migration while the prior run is still stopping.
      rerunRequested ||= activeRunStopObserved
      return
    }
    activeRunStopObserved = false
    rerunRequested = false
    const shouldStop = (): boolean => {
      const stopped = args.isQuitting() || !args.isEligible()
      activeRunStopObserved ||= stopped
      return stopped
    }
    const systemCodexHomePathOverride = args.resolveSystemCodexHomePathOverride()
    let stoppedBackfill = false
    const task = args
      .startBackfill({ shouldStop }, systemCodexHomePathOverride)
      .then((result) => {
        stoppedBackfill = isStoppedMigrationResult(result)
        if (stoppedBackfill || shouldStop()) {
          return
        }
        return args.startIndexHeal({ shouldStop }, systemCodexHomePathOverride)
      })
      .catch((error: unknown) => {
        console.warn('[codex-session-migration] Background session migration failed:', error)
      })
      .then(() => undefined)
    migrationTask = task
    void task.finally(() => {
      if (migrationTask === task) {
        migrationTask = null
        const shouldRerun = rerunRequested || stoppedBackfill
        rerunRequested = false
        activeRunStopObserved = false
        if (shouldRerun) {
          requestRun()
        }
      }
    })
  }

  return {
    scheduleInitialRun(): void {
      if (initialTimer) {
        return
      }
      initialTimer = setTimeout(() => {
        initialTimer = null
        requestRun()
      }, args.initialDelayMs ?? 15_000)
    },
    requestRun
  }
}

function isStoppedMigrationResult(result: unknown): boolean {
  return Boolean(result && typeof result === 'object' && 'stopped' in result && result.stopped)
}
