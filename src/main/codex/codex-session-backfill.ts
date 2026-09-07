import { link, lstat, mkdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import {
  getCodexSessionBackfillStateDirPath,
  getOrcaManagedCodexHomePath,
  getSystemCodexHomePath
} from './codex-home-paths'
import {
  createCodexSessionBackfillAuditPass,
  readCodexSessionTargetStat,
  type CodexSessionBackfillAuditPass
} from './codex-session-backfill-audit-pass'
import { describeCodexSessionBackfillErrorCode } from './codex-session-backfill-audit'
import {
  isCodexSessionRolloutPath,
  listCodexSessionBackfillFilesForDates
} from './codex-session-backfill-date'
import {
  captureCodexSessionBackfillMarkerGeneration,
  readCodexSessionBackfillBaseline,
  writeCodexSessionBackfillMarker as writeBackfillMarker,
  type CodexSessionBackfillBaseline
} from './codex-session-backfill-marker'
import {
  getCodexSessionBackfillDate,
  mergeCodexSessionBackfillDates
} from './codex-session-backfill-scan-dates'
import type {
  CodexSessionBackfillDate,
  CodexSessionBackfillOptions,
  CodexSessionBackfillPaths,
  CodexSessionBackfillSummary
} from './codex-session-backfill-types'

export type {
  CodexSessionBackfillOptions,
  CodexSessionBackfillPaths,
  CodexSessionBackfillSummary
} from './codex-session-backfill-types'

let backgroundBackfillTask: Promise<CodexSessionBackfillSummary | null> | null = null

/**
 * Resolves the production source/target/state paths for the session backfill.
 *
 * `systemCodexHomePathOverride` mirrors the session bridge: users who run
 * Codex with a custom CODEX_HOME need their history placed where their own
 * `codex resume` actually looks.
 */
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

/**
 * Starts the once-per-host background backfill of managed-home session files
 * into the user's real Codex home.
 *
 * Concurrent callers share one in-flight task; a completed-marker host resolves
 * to null without walking the sessions tree.
 */
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
  const markerGeneration = captureCodexSessionBackfillMarkerGeneration()
  const baseline = readCodexSessionBackfillBaseline(paths.markerPath, paths.systemSessionsRoot)
  const scanPlan = resolveCodexSessionBackfillScanPlan(baseline, options)
  if (!scanPlan) {
    return null
  }
  const summary = await backfillManagedCodexSessionsIntoSystemHome(paths, {
    ...options,
    scanDates: scanPlan.scanDates
  })
  // Why: file or heal-queue failures leave the pass uncertified so the next
  // startup retries; skip-existing keeps those retries cheap.
  if (
    !summary.stopped &&
    options.shouldStop?.() !== true &&
    options.canWriteCompletionMarker?.() !== false &&
    summary.failedFiles === 0 &&
    summary.failedDirectories === 0 &&
    summary.failedHealAuditRecords === 0
  ) {
    writeBackfillMarker(paths.markerPath, paths.systemSessionsRoot, summary, markerGeneration, {
      coverage: scanPlan.scanDates ? 'bounded' : 'full',
      coveredScanDates: scanPlan.scanDates ?? [],
      retainPendingScanDates: options.retainPendingScanDates === true
    })
  }
  return summary
}

/**
 * Decides how much of the sessions tree this pass must walk.
 *
 * Null means the baseline already covers everything and there is nothing
 * pending; an absent `scanDates` means a full walk, which is only ever needed
 * when no certified baseline exists (or the caller demands recertification).
 */
function resolveCodexSessionBackfillScanPlan(
  baseline: CodexSessionBackfillBaseline | null,
  options: CodexSessionBackfillOptions
): { scanDates?: readonly CodexSessionBackfillDate[] } | null {
  const requestedScanDates = options.scanDates?.length ? options.scanDates : undefined
  if (options.fullScanRequired) {
    return {}
  }
  if (!baseline) {
    return { scanDates: requestedScanDates }
  }
  const scanDates = mergeCodexSessionBackfillDates(baseline.pendingScanDates, requestedScanDates)
  if (scanDates.length > 0) {
    return { scanDates }
  }
  // Why: a launch-scheduled pass exists to publish rollouts the running pane is
  // creating right now, so with a baseline in hand the current date is enough.
  return options.ignoreCompletionMarker ? { scanDates: [getCodexSessionBackfillDate()] } : null
}

/**
 * Backfills managed-home session rollout files into the real Codex home.
 *
 * Non-destructive by contract: existing target files are always skipped, and
 * nothing in either home is deleted or moved. A hardlink keeps mutable rollout
 * contents coherent; cross-volume snapshots are skipped as unsupported.
 */
export async function backfillManagedCodexSessionsIntoSystemHome(
  paths: CodexSessionBackfillPaths,
  options: CodexSessionBackfillOptions = {}
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
      async (directoryPath, error) => {
        // Why: a partial walk must remain retryable; otherwise an unreadable
        // date directory would be silently omitted behind a completion marker.
        summary.failedDirectories += 1
        await auditPass.appendRecord({
          action: 'scan-failed',
          source: directoryPath,
          error: describeError(error)
        })
      }
    )) {
      if (options.shouldStop?.()) {
        // Why: disabling the real-home lane must bound further writes to at
        // most the single file mutation already in flight.
        summary.stopped = true
        break
      }
      summary.scannedFiles += 1
      if (!isCodexSessionRolloutPath(paths.managedSessionsRoot, managedSessionFilePath)) {
        summary.skippedUnexpectedFiles += 1
        continue
      }
      // Why: sequential async mutations bound disk pressure while keeping the
      // Electron main thread available for UI and PTY work.
      await backfillOneManagedSessionFile(
        paths,
        managedSessionFilePath,
        summary,
        ensuredTargetDirectories,
        auditPass
      )
    }
  }
  summary.stopped ||= options.shouldStop?.() === true
  await auditPass.finish(summary)
  // Why: opt-out can land while the async summary append is pending; carry it
  // back to the marker gate so a managed launch cannot be hidden by stale completion.
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
    // Why: existsSync collapses access failures into "missing," which could
    // permanently hide sessions behind an incorrect completion marker.
    summary.failedDirectories += 1
    await auditPass.appendRecord({
      action: 'scan-failed',
      source: paths.managedSessionsRoot,
      error: describeError(error)
    })
    return false
  }
}

async function backfillOneManagedSessionFile(
  paths: CodexSessionBackfillPaths,
  managedSessionFilePath: string,
  summary: CodexSessionBackfillSummary,
  ensuredTargetDirectories: Set<string>,
  auditPass: CodexSessionBackfillAuditPass
): Promise<void> {
  if (await isSymbolicLink(managedSessionFilePath)) {
    // Why: bridge-created symlinks already point at a file in the user's own
    // home; materializing them here could duplicate a foreign tree.
    summary.skippedSymlinkFiles += 1
    return
  }
  const relativePath = relative(paths.managedSessionsRoot, managedSessionFilePath)
  const systemSessionFilePath = join(paths.systemSessionsRoot, relativePath)
  const existingTargetStat = await readCodexSessionTargetStat(systemSessionFilePath)
  if (existingTargetStat) {
    await auditPass.recordExisting(
      summary,
      managedSessionFilePath,
      systemSessionFilePath,
      existingTargetStat
    )
    return
  }

  let linkAttempted = false
  try {
    const targetDirectory = dirname(systemSessionFilePath)
    if (!ensuredTargetDirectories.has(targetDirectory)) {
      // Why: one date directory can contain thousands of rollouts; avoid a
      // redundant filesystem round trip before every hardlink.
      await mkdir(targetDirectory, { recursive: true })
      ensuredTargetDirectories.add(targetDirectory)
    }
    linkAttempted = true
    await link(managedSessionFilePath, systemSessionFilePath)
    summary.linkedFiles += 1
    await auditPass.recordPublished(
      summary,
      'hardlink',
      managedSessionFilePath,
      systemSessionFilePath
    )
  } catch (linkError) {
    if (linkAttempted && isExistsError(linkError)) {
      // Why: another window can publish the target after our existence probe;
      // enqueue it here too in case that writer died before its audit append.
      await auditPass.recordExisting(
        summary,
        managedSessionFilePath,
        systemSessionFilePath,
        await readCodexSessionTargetStat(systemSessionFilePath)
      )
      return
    }
    if (isNotFoundError(linkError)) {
      ensuredTargetDirectories.delete(dirname(systemSessionFilePath))
    }
    const sourceStat = await readCodexSessionTargetStat(managedSessionFilePath)
    if (linkAttempted && isUnsupportedHardlinkError(linkError)) {
      // Why: a mutable rollout cannot be kept coherent by a cross-volume snapshot.
      summary.skippedUnsupportedFilesystemFiles += 1
      await auditPass.recordDiagnostic(
        {
          action: 'copy-unsupported',
          source: managedSessionFilePath,
          target: systemSessionFilePath,
          linkErrorCode: describeCodexSessionBackfillErrorCode(linkError)
        },
        sourceStat
      )
      return
    }
    summary.failedFiles += 1
    await auditPass.recordDiagnostic(
      {
        action: 'failed',
        source: managedSessionFilePath,
        target: systemSessionFilePath,
        linkError: describeError(linkError),
        linkErrorCode: describeCodexSessionBackfillErrorCode(linkError)
      },
      sourceStat
    )
  }
}

async function isSymbolicLink(filePath: string): Promise<boolean> {
  try {
    return (await lstat(filePath)).isSymbolicLink()
  } catch {
    return false
  }
}

function isExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EEXIST'
}

function isNotFoundError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

function isUnsupportedHardlinkError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EXDEV' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'ENOSYS'
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
