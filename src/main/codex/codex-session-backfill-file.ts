import { link, lstat, mkdir, unlink } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import {
  readCodexSessionTargetStat,
  type CodexSessionBackfillAuditPass
} from './codex-session-backfill-audit-pass'
import { describeCodexSessionBackfillErrorCode } from './codex-session-backfill-audit'
import {
  readArchivedCodexSessionStat,
  removeRedundantActiveCodexSessionHardlink
} from './codex-session-archive'
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
    // Bridge-created symlinks already point into the user's own home.
    summary.skippedSymlinkFiles += 1
    return
  }
  const relativePath = relative(paths.managedSessionsRoot, managedSessionFilePath)
  const systemSessionFilePath = join(paths.systemSessionsRoot, relativePath)
  const archivedSessionFilePath = join(
    paths.systemArchivedSessionsRoot,
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
    // The Codex-owned archived rollout is the durable tombstone.
    await removeRedundantActiveCodexSessionHardlink(
      managedSessionFilePath,
      systemSessionFilePath,
      archivedTargetStat
    )
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

  let linkAttempted = false
  try {
    const targetDirectory = dirname(systemSessionFilePath)
    if (!ensuredTargetDirectories.has(targetDirectory)) {
      await mkdir(targetDirectory, { recursive: true })
      ensuredTargetDirectories.add(targetDirectory)
    }
    linkAttempted = true
    await link(managedSessionFilePath, systemSessionFilePath)
    let archivedAfterLink
    try {
      archivedAfterLink = await readArchivedCodexSessionStat(archivedSessionFilePath)
    } catch (error) {
      await removeNewActiveSessionLink(systemSessionFilePath)
      throw error
    }
    if (archivedAfterLink) {
      // Archive won the publication race; remove only this pass's active link.
      await removeNewActiveSessionLink(systemSessionFilePath)
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
    await recordSessionBackfillFailure(
      managedSessionFilePath,
      systemSessionFilePath,
      linkError,
      summary,
      auditPass,
      sourceStat
    )
  }
}

async function removeNewActiveSessionLink(systemSessionFilePath: string): Promise<void> {
  try {
    await unlink(systemSessionFilePath)
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error
    }
  }
}

async function recordSessionBackfillFailure(
  managedSessionFilePath: string,
  systemSessionFilePath: string,
  error: unknown,
  summary: CodexSessionBackfillSummary,
  auditPass: CodexSessionBackfillAuditPass,
  sourceStat?: Awaited<ReturnType<typeof readCodexSessionTargetStat>>
): Promise<void> {
  summary.failedFiles += 1
  await auditPass.recordDiagnostic(
    {
      action: 'failed',
      source: managedSessionFilePath,
      target: systemSessionFilePath,
      linkError: error instanceof Error ? error.message : String(error),
      linkErrorCode: describeCodexSessionBackfillErrorCode(error)
    },
    sourceStat ?? (await readCodexSessionTargetStat(managedSessionFilePath))
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
  return (error as NodeJS.ErrnoException | null)?.code === 'EEXIST'
}

function isNotFoundError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'
}

function isUnsupportedHardlinkError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EXDEV' || code === 'ENOTSUP' || code === 'EOPNOTSUPP' || code === 'ENOSYS'
}
