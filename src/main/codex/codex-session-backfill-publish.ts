import { link, lstat, mkdir } from 'node:fs/promises'
import { basename, dirname, join, relative } from 'node:path'
import {
  readArchivedCodexRolloutStat,
  removeResurrectedActiveCodexRollout
} from './codex-session-archive'
import { describeCodexSessionBackfillErrorCode } from './codex-session-backfill-audit'
import {
  readCodexSessionTargetStat,
  type CodexSessionBackfillAuditPass
} from './codex-session-backfill-audit-pass'
import type {
  CodexSessionBackfillPaths,
  CodexSessionBackfillSummary
} from './codex-session-backfill-types'

/**
 * Publishes one managed-home rollout into the user's real Codex home.
 *
 * Existing target files are never overwritten, and an archived rollout is left
 * archived. The only removal is an active name that is provably a second
 * hardlink to an already-archived rollout.
 */
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

  let linkAttempted = false
  try {
    // Why: archiving a thread renames its rollout out of `sessions/`, so the
    // active path being absent is not "not published yet". Relinking the
    // still-present managed copy would silently reverse the user's archive.
    const archivedStat = await readArchivedCodexRolloutStat(
      paths.systemSessionsRoot,
      basename(managedSessionFilePath)
    )
    if (archivedStat) {
      await removeResurrectedActiveCodexRollout(systemSessionFilePath, archivedStat)
      summary.skippedArchivedFiles += 1
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
        linkError: linkError instanceof Error ? linkError.message : String(linkError),
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
