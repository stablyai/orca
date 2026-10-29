import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { link, lstat, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../shared/ai-vault-resume-preparation'
import { isPerAccountManagedCodexHome } from '../../shared/ai-vault-resume-preparation'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { parseWslUncPath } from '../../shared/wsl-paths'
import {
  appendCodexSessionHealAuditRecord,
  createCodexSessionBackfillAuditWriter
} from './codex-session-backfill-audit'
import {
  copySessionFileWithoutOverwrite,
  isAtomicNoReplaceUnsupportedError
} from './codex-session-backfill-copy'
import { resolveCodexSessionBackfillPaths } from './codex-session-backfill'
import { codexDatedRolloutRelativePath } from './codex-session-resume-home'
import { ManagedCodexHomeTemporarilyUnavailableError } from '../codex-accounts/host-codex-managed-home-ownership'

const RETRYABLE_RESUME_ERROR =
  'Orca could not safely move this legacy Codex session into your system Codex home. Retry resume; if it still fails, check that both Codex session folders are readable and writable.'

const materializations = new Map<string, Promise<void>>()

export async function prepareLegacySharedCodexSessionResume(
  args: AiVaultPrepareSessionResumeArgs,
  options: {
    isHostSystemDefaultRealHomeSelected: () => boolean
    getSelectedHostAccountCodexHomePath?: () => string | null
    legacyCodexHomePath?: string
    systemCodexHomePath?: string
  }
): Promise<AiVaultPrepareSessionResumeResult> {
  const substituteCodexHome = await resolveSelectedAccountCodexHomeForResume(args, options)
  if (substituteCodexHome) {
    return { useRealCodexHome: false, substituteCodexHome }
  }
  const paths = resolveCodexSessionBackfillPaths(options.systemCodexHomePath)
  const legacyCodexHomePath = options.legacyCodexHomePath ?? dirname(paths.managedSessionsRoot)
  const managedSessionsRoot = join(legacyCodexHomePath, 'sessions')
  if (
    args.agent !== 'codex' ||
    args.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
    !args.codexHome ||
    !sameRuntimePath(args.codexHome, legacyCodexHomePath) ||
    !options.isHostSystemDefaultRealHomeSelected()
  ) {
    return { useRealCodexHome: false }
  }

  const sourcePath = resolve(args.filePath)
  // Codex canonicalizes CODEX_HOME, so Windows transcripts can carry a \\?\ prefix (#27200).
  const relativePath = codexDatedRolloutRelativePath(managedSessionsRoot, sourcePath)
  if (!relativePath) {
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

/** Explicit account restarts must move the verified rollout before changing credentials. */
export async function prepareCodexAccountRestartResume(args: {
  sourceHome: string
  transcriptPath: string
  targetHome: string
  systemCodexHomePath: string
}): Promise<string> {
  if (sameRuntimePath(args.sourceHome, args.targetHome)) {
    return args.targetHome
  }
  const relativePath = codexDatedRolloutRelativePath(
    join(args.sourceHome, 'sessions'),
    resolve(args.transcriptPath)
  )
  if (!relativePath) {
    throw new Error(RETRYABLE_RESUME_ERROR)
  }
  const paths = resolveCodexSessionBackfillPaths(args.systemCodexHomePath)
  await materializeLegacyRollout(
    args.transcriptPath,
    join(args.targetHome, 'sessions', relativePath),
    paths.auditLogPath
  )
  return args.targetHome
}

/**
 * Vault dedup may choose any account's bridge alias; prefer selected credentials when its rollout exists.
 * Return null for unbridged/unsupported layouts; transient read failures must not switch credentials.
 */
async function resolveSelectedAccountCodexHomeForResume(
  args: AiVaultPrepareSessionResumeArgs,
  options: { getSelectedHostAccountCodexHomePath?: () => string | null }
): Promise<string | null> {
  if (
    args.agent !== 'codex' ||
    args.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
    !args.codexHome ||
    parseWslUncPath(args.codexHome) !== null ||
    !isPerAccountManagedCodexHome(args.codexHome)
  ) {
    return null
  }
  const selectedCodexHome = options.getSelectedHostAccountCodexHomePath?.() ?? null
  if (!selectedCodexHome || sameRuntimePath(selectedCodexHome, args.codexHome)) {
    return null
  }
  const relativePath = codexDatedRolloutRelativePath(
    join(args.codexHome, 'sessions'),
    resolve(args.filePath)
  )
  if (!relativePath) {
    return null
  }
  const candidatePath = join(selectedCodexHome, 'sessions', relativePath)
  try {
    const candidateStat = await lstat(candidatePath)
    // The async bridge may not have populated this account yet.
    return candidateStat.isFile() && !candidateStat.isSymbolicLink() ? selectedCodexHome : null
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return null
    }
    // STA-4607: only definitive absence permits fallback; transient errors must not switch accounts.
    throw new ManagedCodexHomeTemporarilyUnavailableError(undefined, { cause: error })
  }
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

function sameRuntimePath(left: string, right: string): boolean {
  return normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right)
}

function isExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EEXIST'
}
