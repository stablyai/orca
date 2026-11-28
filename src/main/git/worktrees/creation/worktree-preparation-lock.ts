import { canonicalWorktreePath } from '../catalog/worktree-path-comparison'
import type { WorktreePreparationOperation } from './worktree-preparation-operation'
import { lstat, readFile, realpath, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../../../../shared/file-access/cross-platform-path'
import {
  resolveGitMetadataPath,
  resolveWorktreeHostPath,
  type GitMetadataPathOptions
} from '../../../../shared/git/metadata/git-metadata-path'
import { toHostFilesystemPath } from '../../../filesystem/host-tree-removal'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import {
  getErrorCode,
  gitExecOptions,
  type GitWorktreeExecOptions
} from '../worktree-operation-options'

export class WorktreePreparationLockOwnershipError extends Error {
  constructor(
    cause?: unknown,
    readonly replaced = false
  ) {
    super('The prepared worktree lock owner changed', { cause })
  }
}

export function resolveWorktreePreparationLockPath(
  worktreePath: string,
  rawLockPath: string,
  rawCommonDir: string,
  options: GitMetadataPathOptions = {}
): string {
  const lockPath = resolveGitMetadataPath(worktreePath, rawLockPath, options)
  const commonDir = resolveGitMetadataPath(worktreePath, rawCommonDir, options)
  if (!lockPath || !commonDir) {
    throw new Error('Git did not return a linked worktree lock path')
  }
  const paths = isWindowsAbsolutePathLike(lockPath) ? win32 : posix
  const segments = paths.relative(commonDir, lockPath).split(paths.sep)
  if (
    segments.length !== 3 ||
    segments[0] !== 'worktrees' ||
    !segments[1] ||
    segments[2] !== 'locked'
  ) {
    throw new Error('Git did not return a linked worktree lock path')
  }
  return lockPath
}

async function readPreparationLockPath(
  worktreePath: string,
  options: GitWorktreeExecOptions
): Promise<string> {
  const { stdout } = await gitExecFileAsync(
    ['rev-parse', '--git-path', 'locked', '--git-common-dir'],
    gitExecOptions(worktreePath, options)
  )
  options.signal?.throwIfAborted()
  const [lock, common, end, ...extra] = stdout.split('\n')
  // Newlines in a path make the combined response ambiguous; read each pointer separately.
  const [rawLock, rawCommon] =
    lock && common && end === '' && extra.length === 0
      ? [lock, common]
      : await Promise.all(
          [
            ['rev-parse', '--git-path', 'locked'],
            ['rev-parse', '--git-common-dir']
          ].map(async (args) => {
            const result = await gitExecFileAsync(args, gitExecOptions(worktreePath, options))
            return result.stdout
          })
        )
  return toHostFilesystemPath(
    resolveWorktreePreparationLockPath(worktreePath, rawLock, rawCommon, options)
  )
}

const CHECKOUT_IDENTITY_FILE = 'orca-checkout-identity'

type CheckoutIdentity = { dev: bigint; ino: bigint; birthtimeNs: bigint }

async function readCheckoutIdentity(
  hostPath: string,
  signal?: AbortSignal
): Promise<CheckoutIdentity | null> {
  const stats = await lstat(toHostFilesystemPath(hostPath), { bigint: true })
  signal?.throwIfAborted()
  if (!stats.isDirectory() || stats.ino <= 0n) {
    return null
  }
  return {
    dev: stats.dev,
    ino: stats.ino,
    birthtimeNs: stats.birthtimeNs > 0n ? stats.birthtimeNs : 0n
  }
}

function parseCheckoutIdentity(raw: string): CheckoutIdentity | null {
  const match = /^(\d+):(\d+):(\d+)\r?\n?$/.exec(raw)
  if (!match) {
    return null
  }
  const ino = BigInt(match[2])
  if (ino <= 0n) {
    return null
  }
  return { dev: BigInt(match[1]), ino, birthtimeNs: BigInt(match[3]) }
}

/** Proves a directory missing its .git file is still the original prepared checkout, not a replacement. */
export async function matchesRecordedPreparationCheckoutIdentity(
  gitDir: string,
  hostPath: string,
  signal?: AbortSignal
): Promise<boolean> {
  try {
    const raw = await readFile(toHostFilesystemPath(join(gitDir, CHECKOUT_IDENTITY_FILE)), 'utf8')
    signal?.throwIfAborted()
    const recorded = parseCheckoutIdentity(raw)
    if (!recorded) {
      return false
    }
    const current = await readCheckoutIdentity(hostPath, signal)
    return (
      current !== null &&
      current.dev === recorded.dev &&
      current.ino === recorded.ino &&
      (recorded.birthtimeNs === 0n ||
        current.birthtimeNs === 0n ||
        current.birthtimeNs === recorded.birthtimeNs)
    )
  } catch {
    return false
  }
}

export async function lockWorktreePreparation(
  worktreePath: string,
  lockReason: string,
  options: GitWorktreeExecOptions,
  operation?: WorktreePreparationOperation
): Promise<string> {
  const lockPath = await readPreparationLockPath(worktreePath, options)
  options.signal?.throwIfAborted()
  // Git's own lock marker is a reason plus newline; exclusive creation preserves another owner.
  try {
    const writing = writeFile(lockPath, `${lockReason}\n`, { flag: 'wx' })
    await (operation ? operation.trackWriter(writing) : writing)
  } catch (error) {
    if (getErrorCode(error) === 'EEXIST') {
      throw new WorktreePreparationLockOwnershipError()
    }
    throw error
  }
  const hostPath = resolveWorktreeHostPath(worktreePath, options)
  if (hostPath) {
    const identity = await readCheckoutIdentity(hostPath, options.signal).catch(() => null)
    if (identity) {
      const writingIdentity = writeFile(
        toHostFilesystemPath(join(dirname(lockPath), CHECKOUT_IDENTITY_FILE)),
        `${identity.dev}:${identity.ino}:${identity.birthtimeNs}\n`,
        { flag: 'wx' }
      ).catch(() => {})
      await (operation ? operation.trackWriter(writingIdentity) : writingIdentity)
    }
  }
  return lockPath
}

export async function unlockWorktreePreparation(
  worktreePath: string,
  expectedLockReason: string,
  options: GitWorktreeExecOptions
): Promise<void> {
  const lockPath = await readPreparationLockPath(worktreePath, options)
  await unlockWorktreePreparationAtPath(lockPath, expectedLockReason, options.signal)
}

/** A move preserves the linked administration directory already verified by finalization. */
export async function unlockWorktreePreparationAtPath(
  lockPath: string,
  expectedLockReason: string,
  signal?: AbortSignal,
  operation?: WorktreePreparationOperation
): Promise<void> {
  await verifyWorktreePreparationLockAtPath(lockPath, expectedLockReason, signal)
  const writing = unlink(lockPath)
  await (operation ? operation.trackWriter(writing) : writing).catch((error: unknown) => {
    throw new WorktreePreparationLockOwnershipError(error)
  })
}

export async function verifyWorktreePreparationLock(
  worktreePath: string,
  expectedLockReason: string,
  options: GitWorktreeExecOptions
): Promise<string> {
  const lockPath = await readPreparationLockPath(worktreePath, options)
  await verifyWorktreePreparationLockAtPath(lockPath, expectedLockReason, options.signal)
  return lockPath
}

export async function verifyWorktreePreparationLockAtPath(
  lockPath: string,
  expectedLockReason: string,
  signal?: AbortSignal
): Promise<void> {
  const lockReason = await readFile(lockPath, 'utf8').catch((error: unknown) => {
    throw new WorktreePreparationLockOwnershipError(error)
  })
  if (lockReason !== `${expectedLockReason}\n`) {
    throw new WorktreePreparationLockOwnershipError(undefined, true)
  }
  signal?.throwIfAborted()
}

export async function verifyOriginalPreparationDirectory(
  gitDir: string,
  originalLockPath: string
): Promise<void> {
  const [actual, original] = await Promise.all([
    realpath(gitDir),
    realpath(dirname(originalLockPath))
  ])
  if (canonicalWorktreePath(actual) !== canonicalWorktreePath(original)) {
    throw new WorktreePreparationLockOwnershipError(undefined, true)
  }
}
