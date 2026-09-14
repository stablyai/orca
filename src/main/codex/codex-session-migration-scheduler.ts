import {
  compareCodexSessionBackfillDates,
  getCodexSessionBackfillDate,
  getCodexSessionBackfillDatesBetween,
  toCodexSessionBackfillDateKey
} from './codex-session-backfill-scan-dates'
import { CodexSessionMigrationIgnoredLaunches } from './codex-session-migration-ignored-launches'
import { CodexSessionMigrationRecentExits } from './codex-session-migration-recent-exits'
import type {
  CodexSessionBackfillDate,
  CodexSessionBackfillOptions
} from './codex-session-backfill-types'

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
  prepareScheduledRun?: (scanDates: readonly CodexSessionBackfillDate[]) => boolean | void
  finishScheduledRun?: () => void
  startBackfill: MigrationRun
  startIndexHeal: MigrationRun
  initialDelayMs?: number
}): CodexSessionMigrationScheduler {
  let scheduledTimer: ReturnType<typeof setTimeout> | null = null
  let scheduledRunGeneration = 0
  let pendingScheduledRunGeneration: number | null = null
  const scheduledScanDates = new Map<string, CodexSessionBackfillDate>()
  const pendingScanDates = new Map<string, CodexSessionBackfillDate>()
  let scheduledFullScan = false
  let pendingFullScan = false
  let migrationTask: Promise<void> | null = null
  const activeLaunches = new Map<string, Date>()
  // Why: non-shared reattach exits must not masquerade as exit-before-begin races for a reused id.
  const ignoredLaunches = new CodexSessionMigrationIgnoredLaunches()
  const ignoredPtyExits = new CodexSessionMigrationRecentExits()
  const earlyPtyExits = new CodexSessionMigrationRecentExits()
  let activeRunStopObserved = false
  let rerunRequested = false

  const requestRun = (
    rerunIfActive = false,
    requestedGeneration?: number,
    requestedScanDates: readonly CodexSessionBackfillDate[] = [],
    requestedFullScan = false
  ): void => {
    if (requestedGeneration !== undefined) {
      pendingScheduledRunGeneration = Math.max(
        requestedGeneration,
        pendingScheduledRunGeneration ?? requestedGeneration
      )
      for (const scanDate of requestedScanDates) {
        pendingScanDates.set(toCodexSessionBackfillDateKey(scanDate), scanDate)
      }
      pendingFullScan ||= requestedFullScan
    }
    if (args.isQuitting() || !args.isEligible()) {
      return
    }
    if (migrationTask) {
      // Why: delayed launches and resumed account transitions must survive an older active pass.
      rerunRequested ||= rerunIfActive || activeRunStopObserved
      return
    }
    const isScheduledRun = pendingScheduledRunGeneration !== null
    const activeScheduledRunGeneration = pendingScheduledRunGeneration
    const runScanDates = [...pendingScanDates.values()].sort(compareCodexSessionBackfillDates)
    let preparationNeedsFullScan = false
    if (isScheduledRun) {
      pendingScheduledRunGeneration = null
      // Why: preparation persists these dates so an abnormal exit still yields a
      // bounded recovery window instead of another full-tree walk.
      preparationNeedsFullScan = args.prepareScheduledRun?.(runScanDates) === true
    }
    const fullScanRequired = pendingFullScan || preparationNeedsFullScan
    const scanDates = !fullScanRequired && runScanDates.length > 0 ? runScanDates : undefined
    pendingScanDates.clear()
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
          scanDates,
          fullScanRequired,
          ignoreCompletionMarker: isScheduledRun,
          // Why: a live pane keeps appending to its own date directory, so that
          // date stays pending — but the historical baseline is still certified.
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
          for (const scanDate of scanDates ?? []) {
            pendingScanDates.set(toCodexSessionBackfillDateKey(scanDate), scanDate)
          }
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
      if (generation !== undefined) {
        const currentDate = getCodexSessionBackfillDate()
        scheduledScanDates.set(toCodexSessionBackfillDateKey(currentDate), currentDate)
      }
      const scanDates = [...scheduledScanDates.values()].sort(compareCodexSessionBackfillDates)
      scheduledScanDates.clear()
      const fullScanRequired = scheduledFullScan
      scheduledFullScan = false
      // Why: a launch can invalidate the marker while a long index-heal pass is active.
      requestRun(true, generation, scanDates, fullScanRequired)
    }, args.initialDelayMs ?? 15_000)
  }

  const scheduleRun = (fullScanRequired = false): void => {
    if (scheduledTimer) {
      clearTimeout(scheduledTimer)
    }
    scheduledRunGeneration += 1
    scheduledFullScan ||= fullScanRequired
    const launchDate = getCodexSessionBackfillDate()
    scheduledScanDates.set(toCodexSessionBackfillDateKey(launchDate), launchDate)
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
      for (const scanDate of getCodexSessionBackfillDatesBetween(startedAt, new Date())) {
        scheduledScanDates.set(toCodexSessionBackfillDateKey(scanDate), scanDate)
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

function isStoppedMigrationResult(result: unknown): boolean {
  return Boolean(result && typeof result === 'object' && 'stopped' in result && result.stopped)
}

function isIncompleteBackfillResult(result: unknown): boolean {
  if (!result || typeof result !== 'object') {
    return true
  }
  return (
    isStoppedMigrationResult(result) ||
    readPositiveResultCount(result, 'failedFiles') ||
    readPositiveResultCount(result, 'failedDirectories') ||
    readPositiveResultCount(result, 'failedHealAuditRecords')
  )
}

function readPositiveResultCount(result: object, key: string): boolean {
  const value = key in result ? (result as Record<string, unknown>)[key] : undefined
  return typeof value === 'number' && value > 0
}
