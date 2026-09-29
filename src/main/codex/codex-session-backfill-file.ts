import { link, lstat, mkdir } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import {
  readCodexSessionTargetStat,
  type CodexSessionBackfillAuditPass
} from './codex-session-backfill-audit-pass'
import { describeCodexSessionBackfillErrorCode } from './codex-session-backfill-audit'
import {
  readArchivedCodexSessionStat,
  removeNewActiveCodexSessionLink,
  removeRedundantActiveCodexSessionHardlink
} from './codex-session-archive-tombstone'
import { classifyInitialCodexPrompt } from './codex-session-worker-classification'
import type {
  CodexSessionBackfillPaths,
  CodexSessionBackfillSummary
} from './codex-session-backfill-types'

export async function backfillOneManagedSessionFile(
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
  const archivedSessionFilePath = join(
    dirname(paths.systemSessionsRoot),
    'archived_sessions',
    basename(managedSessionFilePath)
  )
  let archivedTargetStat
  try {
    archivedTargetStat = await readArchivedCodexSessionStat(archivedSessionFilePath)
  } catch (error) {
    await recordSessionBackfillFailure(
      managedSessionFilePath,
      systemSessionFilePath,
      error,
      summary,
      auditPass
    )
    return
  }
  if (archivedTargetStat) {
    try {
      await removeRedundantActiveCodexSessionHardlink(
        managedSessionFilePath,
        systemSessionFilePath,
        archivedTargetStat
      )
    } catch (error) {
      await recordSessionBackfillFailure(
        managedSessionFilePath,
        systemSessionFilePath,
        error,
        summary,
        auditPass
      )
      return
    }
    summary.skippedExistingFiles += 1
    return
  }
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

  let promptKind
  try {
    promptKind = await classifyInitialCodexPrompt(managedSessionFilePath)
  } catch (error) {
    await recordSessionBackfillFailure(
      managedSessionFilePath,
      systemSessionFilePath,
      error,
      summary,
      auditPass
    )
    return
  }
  if (promptKind === 'worker') {
    summary.skippedWorkerFiles += 1
    return
  }
  if (promptKind === 'pending') {
    summary.deferredFiles += 1
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
    let archivedAfterLink
    try {
      archivedAfterLink = await readArchivedCodexSessionStat(archivedSessionFilePath)
    } catch (error) {
      await removeNewActiveCodexSessionLink(systemSessionFilePath)
      throw error
    }
    if (archivedAfterLink) {
      await removeNewActiveCodexSessionLink(systemSessionFilePath)
      summary.skippedExistingFiles += 1
      return
    }
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

async function recordSessionBackfillFailure(
  source: string,
  target: string,
  error: unknown,
  summary: CodexSessionBackfillSummary,
  auditPass: CodexSessionBackfillAuditPass
): Promise<void> {
  summary.failedFiles += 1
  await auditPass.recordDiagnostic(
    {
      action: 'failed',
      source,
      target,
      linkError: describeError(error),
      linkErrorCode: describeCodexSessionBackfillErrorCode(error)
    },
    await readCodexSessionTargetStat(source)
  )
}

async function isSymbolicLink(filePath: string): Promise<boolean> {
  try {
    return (await lstat(filePath)).isSymbolicLink()
  } catch {
    return false
  }
}

function isExistsError(error: unknown): boolean {
  return errorCode(error) === 'EEXIST'
}

function isNotFoundError(error: unknown): boolean {
  return errorCode(error) === 'ENOENT'
}

function isUnsupportedHardlinkError(error: unknown): boolean {
  const code = errorCode(error)
  return code === 'EXDEV' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'ENOSYS'
}

function errorCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
