import { link, lstat, mkdir } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import {
  getCodexSessionBackfillStateDirPath,
  getOrcaManagedCodexHomePath,
  getSystemCodexHomePath
} from './codex-home-paths'
import {
  appendCodexSessionHealAuditRecord,
  createCodexSessionBackfillAuditWriter,
  recordExistingCodexSessionForHeal,
  type CodexSessionBackfillAuditWriter
} from './codex-session-backfill-audit'
import {
  copySessionFileWithoutOverwrite,
  isAtomicNoReplaceUnsupportedError
} from './codex-session-backfill-copy'
import { listCodexSessionJsonlFilesIncrementally } from './codex-session-file-listing'
import {
  hasCompletedCodexSessionBackfillMarker,
  writeCodexSessionBackfillMarker
} from './codex-session-backfill-marker'
import type {
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
  if (hasCompletedCodexSessionBackfillMarker(paths.markerPath, paths.systemSessionsRoot)) {
    return null
  }
  const summary = await backfillManagedCodexSessionsIntoSystemHome(paths, options)
  // Why: file or heal-queue failures leave the marker unset so the next
  // startup retries; skip-existing keeps those retries cheap.
  if (
    !summary.stopped &&
    options.shouldStop?.() !== true &&
    summary.failedFiles === 0 &&
    summary.failedDirectories === 0 &&
    summary.failedHealAuditRecords === 0
  ) {
    writeCodexSessionBackfillMarker(paths.markerPath, paths.systemSessionsRoot, summary)
  }
  return summary
}

/**
 * Backfills managed-home session rollout files into the real Codex home.
 *
 * Non-destructive by contract: existing target files are always skipped, and
 * nothing in either home is deleted or moved. Hardlink first so resume sees
 * one physical JSONL log; copy is the cross-volume fallback.
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
  const appendAuditRecord = createCodexSessionBackfillAuditWriter(paths.auditLogPath)
  const ensuredTargetDirectories = new Set<string>()
  const managedSessionsRootExists = await checkManagedSessionsRoot(
    paths,
    summary,
    appendAuditRecord
  )
  if (managedSessionsRootExists) {
    for await (const managedSessionFilePath of listCodexSessionJsonlFilesIncrementally(
      paths.managedSessionsRoot,
      options,
      async (directoryPath, error) => {
        // Why: a partial walk must remain retryable; otherwise an unreadable
        // date directory would be silently omitted behind a completion marker.
        summary.failedDirectories += 1
        await appendAuditRecord({
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
      if (!isCodexRolloutPath(paths.managedSessionsRoot, managedSessionFilePath)) {
        summary.skippedUnexpectedFiles += 1
        continue
      }
      // Why: sequential async mutations bound disk pressure while keeping the
      // Electron main thread available for UI and PTY work.
      await backfillOneManagedSessionFile(
        paths,
        managedSessionFilePath,
        summary,
        appendAuditRecord,
        ensuredTargetDirectories
      )
    }
  }
  summary.stopped ||= options.shouldStop?.() === true
  await appendAuditRecord({ action: 'run-summary', ...summary })
  // Why: opt-out can land while the async summary append is pending; carry it
  // back to the marker gate so a managed launch cannot be hidden by stale completion.
  summary.stopped ||= options.shouldStop?.() === true
  return summary
}

async function checkManagedSessionsRoot(
  paths: CodexSessionBackfillPaths,
  summary: CodexSessionBackfillSummary,
  appendAuditRecord: CodexSessionBackfillAuditWriter
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
    await appendAuditRecord({
      action: 'scan-failed',
      source: paths.managedSessionsRoot,
      error: describeError(error)
    })
    return false
  }
}

function isCodexRolloutPath(sessionsRoot: string, filePath: string): boolean {
  const pathParts = relative(sessionsRoot, filePath).split(sep)
  if (pathParts.length !== 4) {
    return false
  }
  const [year, month, day, fileName] = pathParts
  return (
    /^\d{4}$/.test(year) &&
    /^\d{2}$/.test(month) &&
    /^\d{2}$/.test(day) &&
    /^rollout-.+\.jsonl$/.test(fileName)
  )
}

async function backfillOneManagedSessionFile(
  paths: CodexSessionBackfillPaths,
  managedSessionFilePath: string,
  summary: CodexSessionBackfillSummary,
  appendAuditRecord: CodexSessionBackfillAuditWriter,
  ensuredTargetDirectories: Set<string>
): Promise<void> {
  if (await isSymbolicLink(managedSessionFilePath)) {
    // Why: bridge-created symlinks already point at a file in the user's own
    // home; materializing them here could duplicate a foreign tree.
    summary.skippedSymlinkFiles += 1
    return
  }
  const relativePath = relative(paths.managedSessionsRoot, managedSessionFilePath)
  const systemSessionFilePath = join(paths.systemSessionsRoot, relativePath)
  if (await pathEntryExists(systemSessionFilePath)) {
    await recordExistingCodexSessionForHeal(
      appendAuditRecord,
      summary,
      managedSessionFilePath,
      systemSessionFilePath
    )
    return
  }

  try {
    const targetDirectory = dirname(systemSessionFilePath)
    if (!ensuredTargetDirectories.has(targetDirectory)) {
      // Why: one date directory can contain thousands of rollouts; avoid a
      // redundant filesystem round trip before every hardlink.
      await mkdir(targetDirectory, { recursive: true })
      ensuredTargetDirectories.add(targetDirectory)
    }
    await link(managedSessionFilePath, systemSessionFilePath)
    summary.linkedFiles += 1
    await appendCodexSessionHealAuditRecord(appendAuditRecord, summary, {
      action: 'hardlink',
      source: managedSessionFilePath,
      target: systemSessionFilePath
    })
  } catch (linkError) {
    if (isExistsError(linkError)) {
      // Why: another window can publish the target after our existence probe;
      // enqueue it here too in case that writer died before its audit append.
      await recordExistingCodexSessionForHeal(
        appendAuditRecord,
        summary,
        managedSessionFilePath,
        systemSessionFilePath
      )
      return
    }
    if (isNotFoundError(linkError)) {
      ensuredTargetDirectories.delete(dirname(systemSessionFilePath))
    }
    try {
      // Why: cross-volume copies are staged so failures cannot strand a
      // truncated rollout, then installed without overwriting collisions.
      await copySessionFileWithoutOverwrite(managedSessionFilePath, systemSessionFilePath)
      summary.copiedFiles += 1
      await appendCodexSessionHealAuditRecord(appendAuditRecord, summary, {
        action: 'copy',
        source: managedSessionFilePath,
        target: systemSessionFilePath
      })
    } catch (copyError) {
      if (isExistsError(copyError)) {
        await recordExistingCodexSessionForHeal(
          appendAuditRecord,
          summary,
          managedSessionFilePath,
          systemSessionFilePath
        )
        return
      }
      if (isAtomicNoReplaceUnsupportedError(copyError)) {
        summary.skippedUnsupportedFilesystemFiles += 1
        await appendAuditRecord({
          action: 'copy-unsupported',
          source: managedSessionFilePath,
          target: systemSessionFilePath
        })
        return
      }
      summary.failedFiles += 1
      await appendAuditRecord({
        action: 'failed',
        source: managedSessionFilePath,
        target: systemSessionFilePath,
        error: describeError(copyError),
        linkError: describeError(linkError)
      })
    }
  }
}

async function isSymbolicLink(filePath: string): Promise<boolean> {
  try {
    return (await lstat(filePath)).isSymbolicLink()
  } catch {
    return false
  }
}

/** Existence via lstat so a broken symlink at the target still counts as taken. */
async function pathEntryExists(entryPath: string): Promise<boolean> {
  try {
    await lstat(entryPath)
    return true
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

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
