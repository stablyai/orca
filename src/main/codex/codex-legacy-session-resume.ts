import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { link, lstat, mkdir } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../shared/ai-vault-resume-preparation'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import {
  appendCodexSessionHealAuditRecord,
  createCodexSessionBackfillAuditWriter
} from './codex-session-backfill-audit'
import {
  copySessionFileWithoutOverwrite,
  isAtomicNoReplaceUnsupportedError
} from './codex-session-backfill-copy'
import { resolveCodexSessionBackfillPaths } from './codex-session-backfill'

const RETRYABLE_RESUME_ERROR =
  'Orca could not safely move this legacy Codex session into your system Codex home. Retry resume; if it still fails, check that both Codex session folders are readable and writable.'

const materializations = new Map<string, Promise<void>>()

export async function prepareLegacySharedCodexSessionResume(
  args: AiVaultPrepareSessionResumeArgs,
  options: {
    isHostSystemDefaultRealHome: () => boolean
    legacyCodexHomePath?: string
    systemCodexHomePath?: string
  }
): Promise<AiVaultPrepareSessionResumeResult> {
  const paths = resolveCodexSessionBackfillPaths(options.systemCodexHomePath)
  const legacyCodexHomePath = options.legacyCodexHomePath ?? dirname(paths.managedSessionsRoot)
  const managedSessionsRoot = join(legacyCodexHomePath, 'sessions')
  if (
    args.agent !== 'codex' ||
    args.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
    !args.codexHome ||
    !sameRuntimePath(args.codexHome, legacyCodexHomePath) ||
    !options.isHostSystemDefaultRealHome()
  ) {
    return { useRealCodexHome: false }
  }

  const sourcePath = resolve(args.filePath)
  const relativePath = relative(resolve(managedSessionsRoot), sourcePath)
  if (!isLegacyRolloutRelativePath(relativePath)) {
    throw new Error(RETRYABLE_RESUME_ERROR)
  }
  const targetPath = join(paths.systemSessionsRoot, relativePath)
  const key = `${normalizeRuntimePathForComparison(sourcePath)}\0${normalizeRuntimePathForComparison(targetPath)}`
  let task = materializations.get(key)
  if (!task) {
    task = materializeLegacyRollout(sourcePath, targetPath, paths.auditLogPath)
    materializations.set(key, task)
    void task.then(
      () => {
        if (materializations.get(key) === task) {
          materializations.delete(key)
        }
      },
      () => {
        if (materializations.get(key) === task) {
          materializations.delete(key)
        }
      }
    )
  }

  try {
    await task
  } catch (error) {
    console.warn('[codex-legacy-session-resume] Targeted session migration failed:', error)
    throw new Error(RETRYABLE_RESUME_ERROR, { cause: error })
  }
  return { useRealCodexHome: true }
}

async function materializeLegacyRollout(
  sourcePath: string,
  targetPath: string,
  auditLogPath: string
): Promise<void> {
  const sourceStat = await lstat(sourcePath)
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error('Legacy rollout source is not a regular file.')
  }
  await mkdir(dirname(targetPath), { recursive: true })
  try {
    await link(sourcePath, targetPath)
  } catch (linkError) {
    if (isExistsError(linkError)) {
      await assertMatchingExistingTarget(sourcePath, targetPath)
    } else {
      try {
        await copySessionFileWithoutOverwrite(sourcePath, targetPath)
      } catch (copyError) {
        if (isExistsError(copyError)) {
          await assertMatchingExistingTarget(sourcePath, targetPath)
        } else {
          if (isAtomicNoReplaceUnsupportedError(copyError)) {
            throw new Error('The target filesystem cannot safely install this rollout.', {
              cause: copyError
            })
          }
          throw copyError
        }
      }
    }
  }

  const summary = {
    stopped: false,
    scannedFiles: 1,
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
  await appendCodexSessionHealAuditRecord(
    createCodexSessionBackfillAuditWriter(auditLogPath),
    summary,
    { action: 'targeted-resume', source: sourcePath, target: targetPath }
  )
}

async function assertMatchingExistingTarget(sourcePath: string, targetPath: string): Promise<void> {
  const [sourceStat, targetStat] = await Promise.all([lstat(sourcePath), lstat(targetPath)])
  if (
    !targetStat.isFile() ||
    targetStat.isSymbolicLink() ||
    sourceStat.size !== targetStat.size ||
    ((sourceStat.dev !== targetStat.dev || sourceStat.ino !== targetStat.ino) &&
      (await fileDigest(sourcePath)) !== (await fileDigest(targetPath)))
  ) {
    throw new Error('A different rollout already occupies the real-home target path.')
  }
}

async function fileDigest(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

function isLegacyRolloutRelativePath(relativePath: string): boolean {
  if (!relativePath || relativePath.startsWith('..') || resolve(relativePath) === relativePath) {
    return false
  }
  const parts = relativePath.split(sep)
  return (
    parts.length === 4 &&
    /^\d{4}$/.test(parts[0] ?? '') &&
    /^\d{2}$/.test(parts[1] ?? '') &&
    /^\d{2}$/.test(parts[2] ?? '') &&
    /^rollout-.+\.jsonl$/.test(parts[3] ?? '')
  )
}

function sameRuntimePath(left: string, right: string): boolean {
  return normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right)
}

function isExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EEXIST'
}
