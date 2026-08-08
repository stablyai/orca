import { getCodexSessionBackfillDate } from './codex-session-backfill-date'
import type {
  CodexSessionBackfillDate,
  CodexSessionBackfillOptions
} from './codex-session-backfill-types'

type MigrationRun = (
  options: CodexSessionBackfillOptions,
  systemCodexHomePathOverride?: string
) => Promise<unknown>

const EARLY_PTY_EXIT_RETENTION_MS = 60_000
const MAX_EARLY_PTY_EXITS = 256

type EarlyPtyExit = { sequence: number; recordedAt: number }

export type CodexSessionMigrationScheduler = {
  beginLaunch(
    leaseId: string,
    fullScanRequired?: boolean,
    startedAt?: Date,
    startedSequence?: number
  ): void
  finishLaunch(leaseId: string, exitSequence?: number): void
  scheduleInitialRun(): void
  scheduleRun(fullScanRequired?: boolean): void
  requestRun(): void
}

export function createCodexSessionMigrationScheduler(args: {
  isEligible: () => boolean
  isQuitting: () => boolean
  resolveSystemCodexHomePathOverride: () => string | undefined
  prepareScheduledRun?: () => boolean | void
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
  const earlyPtyExits = new Map<string, EarlyPtyExit>()
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
        pendingScanDates.set(scanDate.join('-'), scanDate)
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
    let preparationNeedsFullScan = false
    if (isScheduledRun) {
      pendingScheduledRunGeneration = null
      // Why: an older active pass can rewrite the marker after launch invalidates it.
      preparationNeedsFullScan = args.prepareScheduledRun?.() === true
    }
    const fullScanRequired = pendingFullScan || preparationNeedsFullScan
    const scanDates =
      !fullScanRequired && pendingScanDates.size > 0
        ? [...pendingScanDates.values()].sort(compareBackfillDates)
        : undefined
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
          ignoreCompletionMarker: isScheduledRun,
          writeCompletionMarker: activeLaunches.size === 0,
          writeBoundedCompletionMarker:
            isScheduledRun && activeLaunches.size === 0 && !fullScanRequired,
          canWriteCompletionMarker: () =>
            activeLaunches.size === 0 &&
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
            pendingScanDates.set(scanDate.join('-'), scanDate)
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
        scheduledScanDates.set(currentDate.join('-'), currentDate)
      }
      const scanDates = [...scheduledScanDates.values()].sort(compareBackfillDates)
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
    scheduledScanDates.set(launchDate.join('-'), launchDate)
    armScheduledRun(scheduledRunGeneration)
  }

  return {
    beginLaunch(leaseId, fullScanRequired = false, startedAt = new Date(), startedSequence): void {
      if (args.isQuitting() || activeLaunches.has(leaseId)) {
        return
      }
      if (consumeEarlyPtyExit(earlyPtyExits, leaseId, startedSequence)) {
        scheduleRun(true)
        return
      }
      activeLaunches.set(leaseId, startedAt)
      scheduleRun(fullScanRequired)
    },
    finishLaunch(leaseId, exitSequence): void {
      const startedAt = activeLaunches.get(leaseId)
      if (!startedAt) {
        if (exitSequence !== undefined) {
          recordEarlyPtyExit(earlyPtyExits, leaseId, exitSequence)
        }
        return
      }
      activeLaunches.delete(leaseId)
      if (args.isQuitting()) {
        return
      }
      for (const scanDate of getCodexSessionBackfillDatesBetween(startedAt, new Date())) {
        scheduledScanDates.set(scanDate.join('-'), scanDate)
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

function getCodexSessionBackfillDatesBetween(
  startedAt: Date,
  finishedAt: Date
): CodexSessionBackfillDate[] {
  const dates: CodexSessionBackfillDate[] = []
  const cursor = new Date(
    Date.UTC(startedAt.getUTCFullYear(), startedAt.getUTCMonth(), startedAt.getUTCDate())
  )
  const last = new Date(
    Date.UTC(finishedAt.getUTCFullYear(), finishedAt.getUTCMonth(), finishedAt.getUTCDate())
  )
  while (cursor <= last) {
    dates.push(getCodexSessionBackfillDate(cursor))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return dates
}

function compareBackfillDates(
  left: CodexSessionBackfillDate,
  right: CodexSessionBackfillDate
): number {
  return left.join('-').localeCompare(right.join('-'))
}

function recordEarlyPtyExit(
  exits: Map<string, EarlyPtyExit>,
  leaseId: string,
  sequence: number
): void {
  const now = Date.now()
  for (const [id, exit] of exits) {
    if (now - exit.recordedAt > EARLY_PTY_EXIT_RETENTION_MS) {
      exits.delete(id)
    }
  }
  exits.set(leaseId, { sequence, recordedAt: now })
  while (exits.size > MAX_EARLY_PTY_EXITS) {
    const oldestLeaseId = exits.keys().next().value
    if (oldestLeaseId === undefined) {
      break
    }
    exits.delete(oldestLeaseId)
  }
}

function consumeEarlyPtyExit(
  exits: Map<string, EarlyPtyExit>,
  leaseId: string,
  startedSequence: number | undefined
): boolean {
  const exit = exits.get(leaseId)
  exits.delete(leaseId)
  return (
    exit !== undefined &&
    startedSequence !== undefined &&
    exit.sequence > startedSequence &&
    Date.now() - exit.recordedAt <= EARLY_PTY_EXIT_RETENTION_MS
  )
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
