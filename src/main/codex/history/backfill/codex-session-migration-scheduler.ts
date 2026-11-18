import { CodexSessionMigrationIgnoredLaunches } from './codex-session-migration-ignored-launches'
import { CodexSessionMigrationRecentExits } from './codex-session-migration-recent-exits'
import type { CodexSessionBackfillOptions } from './codex-session-backfill-types'

type MigrationRun = (
  options: CodexSessionBackfillOptions,
  systemCodexHomePathOverride?: string
) => Promise<unknown>

export type CodexSessionMigrationScheduler = {
  beginLaunch(
    leaseId: string,
    fullScanRequired?: boolean,
    startedAt?: Date,
    startedSequence?: number
  ): void
  ignoreLaunch(leaseId: string, startedSequence: number): void
  finishLaunch(leaseId: string, exitSequence?: number): void
  scheduleInitialRun(): void
  scheduleRun(fullScanRequired?: boolean): void
  requestRun(): void
}

export function createCodexSessionMigrationScheduler(args: {
  isEligible: () => boolean
  isQuitting: () => boolean
  resolveSystemCodexHomePathOverride: () => string | undefined
  prepareScheduledRun?: (fullScanRequired: boolean, newFullScanRequest?: boolean) => boolean | void
  finishScheduledRun?: () => void
  startBackfill: MigrationRun
  startIndexHeal: MigrationRun
  initialDelayMs?: number
}): CodexSessionMigrationScheduler {
  let scheduledTimer: ReturnType<typeof setTimeout> | null = null
  let scheduledRunGeneration = 0
  let pendingScheduledRunGeneration: number | null = null
  let scheduledFullScan = false
  let pendingFullScan = false
  let migrationTask: Promise<void> | null = null
  const activeLaunches = new Map<string, Date>()
  // Keep non-shared reattach exits out of exit-before-begin recovery for reused IDs.
  const ignoredLaunches = new CodexSessionMigrationIgnoredLaunches()
  const ignoredPtyExits = new CodexSessionMigrationRecentExits()
  const earlyPtyExits = new CodexSessionMigrationRecentExits()
  let activeRunStopObserved = false
  let rerunRequested = false

  const requestRun = (
    rerunIfActive = false,
    requestedGeneration?: number,
    requestedFullScan = false
  ): void => {
    if (requestedGeneration !== undefined) {
      pendingScheduledRunGeneration = Math.max(
        requestedGeneration,
        pendingScheduledRunGeneration ?? requestedGeneration
      )
      pendingFullScan ||= requestedFullScan
    }
    if (args.isQuitting() || !args.isEligible()) {
      return
    }
    if (migrationTask) {
      // Preserve delayed launches and resumed account transitions across an older active pass.
      rerunRequested ||= rerunIfActive || activeRunStopObserved
      return
    }
    const isScheduledRun = pendingScheduledRunGeneration !== null
    const activeScheduledRunGeneration = pendingScheduledRunGeneration
    let preparationNeedsFullScan = false
    if (isScheduledRun) {
      pendingScheduledRunGeneration = null
      // Persist launch debt before starting asynchronous publication.
      preparationNeedsFullScan = args.prepareScheduledRun?.(pendingFullScan) === true
    }
    const fullScanRequired = pendingFullScan || preparationNeedsFullScan
    pendingFullScan = false
    activeRunStopObserved = false
    rerunRequested = false
    const shouldStop = (): boolean => {
      const stopped = args.isQuitting() || !args.isEligible()
      activeRunStopObserved ||= stopped
      return stopped
    }
    const systemCodexHomePathOverride = args.resolveSystemCodexHomePathOverride()
    let stoppedBackfill = false
    let incompleteBackfill = true
    const task = args
      .startBackfill(
        {
          shouldStop,
          boundedScan: isScheduledRun,
          fullScanRequired,
          ignoreCompletionMarker: isScheduledRun,
          // Live panes keep their dates pending while historical dates can be certified.
          retainPendingScanDates: activeLaunches.size > 0,
          canWriteCompletionMarker: () =>
            scheduledTimer === null &&
            pendingScheduledRunGeneration === null &&
            (!isScheduledRun || activeScheduledRunGeneration === scheduledRunGeneration)
        },
        systemCodexHomePathOverride
      )
      .then((result) => {
        stoppedBackfill = isStoppedMigrationResult(result)
        incompleteBackfill = isIncompleteBackfillResult(result)
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
        const scheduledRunIncomplete = stoppedBackfill || activeRunStopObserved
        const shouldRerun = rerunRequested || scheduledRunIncomplete
        rerunRequested = false
        activeRunStopObserved = false
        if ((shouldRerun || incompleteBackfill) && isScheduledRun) {
          pendingScheduledRunGeneration = Math.max(
            activeScheduledRunGeneration!,
            pendingScheduledRunGeneration ?? activeScheduledRunGeneration!
          )
          pendingFullScan ||= fullScanRequired
        }
        if (
          isScheduledRun &&
          !incompleteBackfill &&
          activeLaunches.size === 0 &&
          scheduledTimer === null &&
          pendingScheduledRunGeneration === null
        ) {
          args.finishScheduledRun?.()
        }
        if (shouldRerun) {
          requestRun()
        }
      }
    })
  }

  const armScheduledRun = (generation?: number): void => {
    scheduledTimer = setTimeout(() => {
      scheduledTimer = null
      const fullScanRequired = scheduledFullScan
      scheduledFullScan = false
      // A launch can invalidate the marker while index healing is still active.
      requestRun(true, generation, fullScanRequired)
    }, args.initialDelayMs ?? 15_000)
  }

  const scheduleRun = (fullScanRequired = false): void => {
    if (scheduledTimer) {
      clearTimeout(scheduledTimer)
    }
    scheduledRunGeneration += 1
    scheduledFullScan ||= fullScanRequired
    if (fullScanRequired && args.isEligible() && !args.isQuitting()) {
      args.prepareScheduledRun?.(true, true)
    }
    armScheduledRun(scheduledRunGeneration)
  }

  return {
    beginLaunch(leaseId, fullScanRequired = false, startedAt = new Date(), startedSequence): void {
      if (args.isQuitting() || activeLaunches.has(leaseId)) {
        return
      }
      if (earlyPtyExits.consumeAfter(leaseId, startedSequence)) {
        scheduleRun(true)
        return
      }
      activeLaunches.set(leaseId, startedAt)
      scheduleRun(fullScanRequired)
    },
    ignoreLaunch(leaseId, startedSequence): void {
      if (args.isQuitting() || ignoredLaunches.has(leaseId)) {
        return
      }
      if (ignoredPtyExits.matchesAfter(leaseId, startedSequence)) {
        return
      }
      const earlyExit = earlyPtyExits.consumeAfter(leaseId, startedSequence)
      if (earlyExit) {
        ignoredPtyExits.record(leaseId, earlyExit.sequence)
        return
      }
      ignoredLaunches.add(leaseId)
    },
    finishLaunch(leaseId, exitSequence): void {
      if (ignoredLaunches.delete(leaseId)) {
        if (exitSequence !== undefined) {
          ignoredPtyExits.record(leaseId, exitSequence)
        }
        return
      }
      const startedAt = activeLaunches.get(leaseId)
      if (!startedAt) {
        if (exitSequence !== undefined) {
          earlyPtyExits.record(leaseId, exitSequence)
        }
        return
      }
      activeLaunches.delete(leaseId)
      if (args.isQuitting()) {
        return
      }
      scheduleRun()
    },
    scheduleInitialRun(): void {
      if (!scheduledTimer) {
        armScheduledRun()
      }
    },
    scheduleRun,
    requestRun: () => requestRun()
  }
}

type MigrationFailureCountKey = 'failedDirectories' | 'failedFiles' | 'failedHealAuditRecords'

type MigrationResultFields = Partial<Record<MigrationFailureCountKey, unknown>> & {
  scanTruncated?: unknown
}

function isMigrationResultFields(result: unknown): result is MigrationResultFields {
  return typeof result === 'object' && result !== null
}

function isStoppedMigrationResult(result: unknown): boolean {
  return Boolean(result && typeof result === 'object' && 'stopped' in result && result.stopped)
}

function isIncompleteBackfillResult(result: unknown): boolean {
  if (!isMigrationResultFields(result)) {
    return true
  }
  return (
    result.scanTruncated === true ||
    isStoppedMigrationResult(result) ||
    readPositiveResultCount(result, 'failedFiles') ||
    readPositiveResultCount(result, 'failedDirectories') ||
    readPositiveResultCount(result, 'failedHealAuditRecords')
  )
}

function readPositiveResultCount(
  result: MigrationResultFields,
  key: MigrationFailureCountKey
): boolean {
  const value = result[key]
  return typeof value === 'number' && value > 0
}
