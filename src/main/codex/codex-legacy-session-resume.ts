import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../shared/ai-vault-resume-preparation'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { getSystemCodexHomePath } from './codex-home-paths'
import { resolveCodexLaunchHome, type CodexLaunchHomeOptions } from './codex-launch-home'
import {
  codexDatedRolloutRelativePath,
  findTrustedCodexSessionResume
} from './codex-session-resume-home'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { link, lstat, mkdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
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

/** File logins retain the original store; no-file System default follows terminal resume. */
export async function prepareLegacySharedCodexSessionResume(
  args: AiVaultPrepareSessionResumeArgs,
  options: {
    isHostSystemDefaultRealHomeSelected: () => boolean
    getSelectedHostAccountCodexHomePath?: () => string | null
    legacyCodexHomePath?: string
    systemCodexHomePath?: string
    storeHomePath?: string
  }
): Promise<AiVaultPrepareSessionResumeResult> {
  if (
    args.agent !== 'codex' ||
    args.executionHostId !== LOCAL_EXECUTION_HOST_ID ||
    (args.codexHome && parseWslUncPath(args.codexHome))
  ) {
    return { useRealCodexHome: false }
  }
  const systemHome = options.systemCodexHomePath ?? getSystemCodexHomePath()
  const selectedHome = options.getSelectedHostAccountCodexHomePath?.()
  const home = await prepareCodexLaunchHome({
    selectedAccount: selectedHome ? { homePath: selectedHome } : null,
    conversationHome: args.codexHome ?? options.storeHomePath ?? systemHome,
    systemHome,
    transcriptPath: args.filePath,
    sessionId: args.sessionId
  })
  return home ? { useRealCodexHome: false, substituteCodexHome: home } : { useRealCodexHome: true }
}

/** Read-only routing never copies; an actual no-file System-default continuation awaits main's materializer. */
export async function prepareCodexLaunchHome(
  options: CodexLaunchHomeOptions & { transcriptPath?: string; sessionId?: string }
): Promise<string | undefined> {
  const home = resolveCodexLaunchHome(options)
  const sourceHome = options.conversationHome
  const systemHome = options.systemHome ?? getSystemCodexHomePath()
  if (
    options.readOnly ||
    home ||
    options.selectedAccount ||
    !sourceHome ||
    sameRuntimePath(sourceHome, systemHome) ||
    (!options.transcriptPath && !options.sessionId)
  ) {
    return home
  }
  const source = options.transcriptPath
    ? { homePath: sourceHome, transcriptPath: options.transcriptPath }
    : await findTrustedCodexSessionResume({
        sessionId: options.sessionId ?? '',
        transcriptPath: options.transcriptPath,
        trustedCodexHomes: [sourceHome],
        getSelectedAccountCodexHome: () => null,
        systemCodexHomePath: systemHome,
        sharedRuntimeCodexHomePath: null
      })
  if (!source) {
    // The provider owns missing-rollout errors and replacement of its own unsaved thread.
    return home
  }
  try {
    await prepareCodexAccountRestartResume({
      sourceHome: source.homePath,
      transcriptPath: source.transcriptPath,
      targetHome: systemHome,
      systemCodexHomePath: systemHome
    })
  } catch (error) {
    throw new Error(RETRYABLE_RESUME_ERROR, { cause: error })
  }
  return home
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
    if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk)) {
      throw new Error('Unexpected rollout stream chunk.')
    }
    hash.update(chunk)
  }
  return hash.digest('hex')
}

function sameRuntimePath(left: string, right: string): boolean {
  return normalizeRuntimePathForComparison(left) === normalizeRuntimePathForComparison(right)
}

function isExistsError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}
