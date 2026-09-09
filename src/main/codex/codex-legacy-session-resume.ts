import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { link, lstat, mkdir } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
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
import { ManagedCodexHomeTemporarilyUnavailableError } from '../codex-accounts/host-codex-managed-home-ownership'

const RETRYABLE_RESUME_ERROR =
  'Orca could not safely move this legacy Codex session into your system Codex home. Retry resume; if it still fails, check that both Codex session folders are readable and writable.'

const materializations = new Map<string, Promise<void>>()

export async function prepareLegacySharedCodexSessionResume(
  args: AiVaultPrepareSessionResumeArgs,
  options: {
    isHostSystemDefaultRealHome: () => boolean
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
    !options.isHostSystemDefaultRealHome()
  ) {
    return { useRealCodexHome: false }
  }

  const sourcePath = resolve(args.filePath)
  const relativePath = relative(resolve(managedSessionsRoot), sourcePath)
  if (!isDatedRolloutRelativePath(relativePath)) {
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

/**
 * Repins a per-account resume to the selected account's home, or null to keep
 * the session's own home.
 *
 * Why: the session bridge hardlinks each rollout into every per-account home,
 * and vault dedup keeps the lexicographically-smallest alias — which names an
 * arbitrary account. When the selected account's home holds the same rollout
 * at the same sessions-relative path, resume must run under that account's
 * credentials. Every uncertain branch (no selection, unbridged rollout, odd
 * layout) declines, so resume degrades to today's behavior instead of failing.
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
  const relativePath = relative(resolve(join(args.codexHome, 'sessions')), resolve(args.filePath))
  if (!isDatedRolloutRelativePath(relativePath)) {
    return null
  }
  const candidatePath = join(selectedCodexHome, 'sessions', relativePath)
  try {
    const candidateStat = await lstat(candidatePath)
    // Why: the bridge is async, so an unbridged rollout is a real state — decline rather than pin a home codex cannot resume from.
    return candidateStat.isFile() && !candidateStat.isSymbolicLink() ? selectedCodexHome : null
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return null
    }
    // Why: a blanket catch here declined the SELECTED account on a briefly
    // locked file and kept the source per-account home, resuming under another
    // account's credentials while the UI still showed the selected one. Only a
    // definitive absence means "not bridged here" (STA-4607).
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

function isDatedRolloutRelativePath(relativePath: string): boolean {
  if (!relativePath || relativePath.startsWith('..') || resolve(relativePath) === relativePath) {
    return false
  }
  const parts = relativePath.split(sep)
  return (
    parts.length === 4 &&
    /^\d{4}$/.test(parts[0] ?? '') &&
    /^\d{2}$/.test(parts[1] ?? '') &&
    /^\d{2}$/.test(parts[2] ?? '') &&
    /^rollout-.+\.jsonl(?:\.zst)?$/.test(parts[3] ?? '')
  )
}

function sameRuntimePath(left: string, right: string): boolean {
  return normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right)
}

function isExistsError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === 'EEXIST'
}
