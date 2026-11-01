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
  // Leave failed passes uncertified so the next startup retries without overwriting published files.
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

// Missing scanDates requests a full walk; null skips an already-covered baseline.
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
  // With certified history, a launch pass only needs the date receiving new rollouts.
  return options.ignoreCompletionMarker ? { scanDates: [getCodexSessionBackfillDate()] } : null
}

/** Hardlink mutable rollouts without replacing existing targets; cross-volume snapshots cannot stay coherent. */
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

async function backfillOneManagedSessionFile(
  paths: CodexSessionBackfillPaths,
  managedSessionFilePath: string,
  summary: CodexSessionBackfillSummary,
  ensuredTargetDirectories: Set<string>,
  auditPass: CodexSessionBackfillAuditPass
): Promise<void> {
  if (await isSymbolicLink(managedSessionFilePath)) {
    // Bridge symlinks already point into the system home; materializing them could duplicate history.
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
      // A concurrent publisher may have died before auditing; enqueue its existing target for healing.
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
