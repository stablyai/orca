import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { backfillOneManagedSessionFile } from './codex-session-backfill-publish'
import {
  getCodexSessionBackfillStateDirPath,
  getOrcaManagedCodexHomePath,
  getSystemCodexHomePath
} from '../../configuration/homes/codex-home-paths'
import {
  createCodexSessionBackfillAuditPass,
  type CodexSessionBackfillAuditPass
} from './codex-session-backfill-audit-pass'
import {
  isCodexSessionRolloutPath,
  listCodexSessionBackfillFilesForDates
} from './codex-session-backfill-date'
import {
  captureCodexSessionBackfillMarkerGeneration,
  readCodexSessionBackfillBaseline,
  markCodexSessionBackfillMarkerNeedsFullScan,
  writeCodexSessionBackfillMarker as writeBackfillMarker
} from './codex-session-backfill-marker'
import { resolveCodexSessionBackfillScanPlan } from './codex-session-backfill-scan-dates'
import type {
  CodexSessionBackfillOptions,
  CodexSessionBackfillScanProgress,
  CodexSessionBackfillPaths,
  CodexSessionBackfillSummary
} from './codex-session-backfill-types'

let backgroundBackfillTask: Promise<CodexSessionBackfillSummary | null> | null = null

/** Custom CODEX_HOME users need history where their own codex resume looks. */
export function resolveCodexSessionBackfillPaths(
  systemCodexHomePathOverride?: string
): CodexSessionBackfillPaths {
  const stateDir = getCodexSessionBackfillStateDirPath()
  return {
    managedSessionsRoot: join(getOrcaManagedCodexHomePath(), 'sessions'),
    systemSessionsRoot: join(systemCodexHomePathOverride || getSystemCodexHomePath(), 'sessions'),
    auditLogPath: join(stateDir, 'audit.jsonl'),
    markerPath: join(stateDir, 'backfill-complete.json')
  }
}

export function startCodexSessionBackfillInBackground(
  options: CodexSessionBackfillOptions = {},
  systemCodexHomePathOverride?: string
): Promise<CodexSessionBackfillSummary | null> {
  if (backgroundBackfillTask) {
    return backgroundBackfillTask
  }
  const task = runCodexSessionBackfillOncePerHost(options, systemCodexHomePathOverride).catch(
    (error: unknown) => {
      console.warn('[codex-session-backfill] Background session backfill failed:', error)
      return null
    }
  )
  backgroundBackfillTask = task
  void task.finally(() => {
    if (backgroundBackfillTask === task) {
      backgroundBackfillTask = null
    }
  })
  return task
}

async function runCodexSessionBackfillOncePerHost(
  options: CodexSessionBackfillOptions,
  systemCodexHomePathOverride?: string
): Promise<CodexSessionBackfillSummary | null> {
  const paths = resolveCodexSessionBackfillPaths(systemCodexHomePathOverride)
  if (options.fullScanRequired) {
    markCodexSessionBackfillMarkerNeedsFullScan(paths.markerPath)
  }
  const markerGeneration = captureCodexSessionBackfillMarkerGeneration()
  const baseline = readCodexSessionBackfillBaseline(paths.markerPath, paths.systemSessionsRoot)
  const scanPlan = resolveCodexSessionBackfillScanPlan(baseline, options)
  if (!scanPlan) {
    return null
  }
  const progress: CodexSessionBackfillScanProgress = { recentDates: [], truncated: false }
  const summary = await backfillManagedCodexSessionsIntoSystemHome(
    paths,
    {
      ...options,
      ...scanPlan
    },
    progress
  )
  // Leave failed passes uncertified so the next startup retries without overwriting published files.
  if (
    !summary.stopped &&
    options.shouldStop?.() !== true &&
    options.canWriteCompletionMarker?.() !== false &&
    (summary.deferredFiles ?? 0) === 0 &&
    summary.failedFiles === 0 &&
    summary.failedDirectories === 0 &&
    summary.failedHealAuditRecords === 0
  ) {
    writeBackfillMarker(paths.markerPath, paths.systemSessionsRoot, summary, markerGeneration, {
      coverage:
        !scanPlan.scanFrom &&
        (!scanPlan.boundedScan || (!baseline?.hasBaseline && !progress.truncated))
          ? 'full'
          : 'bounded',
      coveredScanDates: baseline?.pendingScanDates ?? [],
      progress,
      resumed: !!scanPlan.scanCursor,
      scanFrom: scanPlan.scanFrom,
      retainPendingScanDates: options.retainPendingScanDates === true
    })
  }
  return summary
}

/** Hardlink mutable rollouts without replacing existing targets; cross-volume snapshots cannot stay coherent. */
export async function backfillManagedCodexSessionsIntoSystemHome(
  paths: CodexSessionBackfillPaths,
  options: CodexSessionBackfillOptions = {},
  progress: CodexSessionBackfillScanProgress = { recentDates: [], truncated: false }
): Promise<CodexSessionBackfillSummary> {
  const summary: CodexSessionBackfillSummary = {
    stopped: false,
    scannedFiles: 0,
    linkedFiles: 0,
    copiedFiles: 0,
    skippedExistingFiles: 0,
    skippedUnexpectedFiles: 0,
    skippedSymlinkFiles: 0,
    skippedUnsupportedFilesystemFiles: 0,
    failedDirectories: 0,
    failedFiles: 0,
    failedHealAuditRecords: 0
  }
  const auditPass = await createCodexSessionBackfillAuditPass(paths.auditLogPath)
  const ensuredTargetDirectories = new Set<string>()
  const managedSessionsRootExists = await checkManagedSessionsRoot(paths, summary, auditPass)
  if (managedSessionsRootExists) {
    for await (const managedSessionFilePath of listCodexSessionBackfillFilesForDates(
      paths.managedSessionsRoot,
      options,
      progress,
      async (directoryPath, error) => {
        // Incomplete walks must remain retryable instead of certifying unreadable dates.
        summary.failedDirectories += 1
        await auditPass.appendRecord({
          action: 'scan-failed',
          source: directoryPath,
          error: describeError(error)
        })
      }
    )) {
      if (options.shouldStop?.()) {
        // Opt-out permits at most the file mutation already in flight.
        summary.stopped = true
        break
      }
      summary.scannedFiles += 1
      if (!isCodexSessionRolloutPath(paths.managedSessionsRoot, managedSessionFilePath)) {
        summary.skippedUnexpectedFiles += 1
        continue
      }
      // Sequential async writes bound disk pressure without blocking UI or PTY work.
      await backfillOneManagedSessionFile(
        paths,
        managedSessionFilePath,
        summary,
        ensuredTargetDirectories,
        auditPass
      )
    }
  }
  summary.scanTruncated = progress.truncated
  summary.stopped ||= options.shouldStop?.() === true
  await auditPass.finish(summary)
  // Recheck opt-out after the async append so a stopped pass cannot certify completion.
  summary.stopped ||= options.shouldStop?.() === true
  return summary
}

async function checkManagedSessionsRoot(
  paths: CodexSessionBackfillPaths,
  summary: CodexSessionBackfillSummary,
  auditPass: CodexSessionBackfillAuditPass
): Promise<boolean> {
  try {
    await lstat(paths.managedSessionsRoot)
    return true
  } catch (error) {
    if (isNotFoundError(error)) {
      return false
    }
    // Access failures cannot count as absence and incorrectly certify completion.
    summary.failedDirectories += 1
    await auditPass.appendRecord({
      action: 'scan-failed',
      source: paths.managedSessionsRoot,
      error: describeError(error)
    })
    return false
  }
}

function isNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
