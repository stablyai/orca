import { readFile, unlink, writeFile } from 'node:fs/promises'
import { posix, win32 } from 'node:path'
import { isWindowsAbsolutePathLike } from '../../shared/cross-platform-path'
import { resolveGitMetadataPath, type GitMetadataPathOptions } from '../../shared/git-metadata-path'
import { toHostFilesystemPath } from '../host-tree-removal'
import { gitExecFileAsync } from './runner'
import {
  getErrorCode,
  gitExecOptions,
  type GitWorktreeExecOptions
} from './worktree-operation-options'

export class WorktreePreparationLockOwnershipError extends Error {
  constructor(cause?: unknown) {
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

export async function lockWorktreePreparation(
  worktreePath: string,
  lockReason: string,
  options: GitWorktreeExecOptions
): Promise<string> {
  const lockPath = await readPreparationLockPath(worktreePath, options)
  options.signal?.throwIfAborted()
  // Git's own lock marker is a reason plus newline; exclusive creation preserves another owner.
  try {
    await writeFile(lockPath, `${lockReason}\n`, { flag: 'wx' })
  } catch (error) {
    if (getErrorCode(error) === 'EEXIST') {
      throw new WorktreePreparationLockOwnershipError()
    }
    throw error
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
  signal?: AbortSignal
): Promise<void> {
  await verifyWorktreePreparationLockAtPath(lockPath, expectedLockReason, signal)
  await unlink(lockPath).catch((error: unknown) => {
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
    throw new WorktreePreparationLockOwnershipError()
  }
  signal?.throwIfAborted()
}
