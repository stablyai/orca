import { bumpWorktreeScanGeneration } from '../catalog/worktree-scan-cache'
import { runWithGitReadCacheInvalidation } from '../../source-control/git-read-cache-invalidation'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'
import { parseGitdirMarkerPayload } from '../../../../shared/git/metadata/gitdir-marker-payload'
import { canonicalWorktreePath } from '../catalog/worktree-path-comparison'
import {
  resolveGitMetadataPath,
  resolveWorktreeHostPath
} from '../../../../shared/git/metadata/git-metadata-path'
import { findLinkedWorktreeGitDirectory } from '../../../../shared/git/worktrees/git-worktree-admin'
import { windowsLongPathGitArgs } from '../../../../shared/windows-long-path-git-args'
import { toHostFilesystemPath } from '../../../filesystem/host-tree-removal'
import { gitExecFileAsync } from '../../command-runner/git-exec-file'
import {
  getErrorCode,
  gitExecOptions,
  WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS,
  type GitExecOptionsForWorktree,
  type GitWorktreeExecOptions
} from '../worktree-operation-options'
import {
  verifyOriginalPreparationDirectory,
  verifyWorktreePreparationLock,
  verifyWorktreePreparationLockAtPath,
  WorktreePreparationLockOwnershipError
} from './worktree-preparation-lock'
import { invalidateWslLinkedWorktreeGitRouting } from '../../command-runner/host-routing/wsl-linked-worktree-git-routing'

export function gitCleanupOptions(
  cwd: string,
  options: GitWorktreeExecOptions
): GitExecOptionsForWorktree {
  // Cancellation must not strand a partial move; cleanup has its own bound.
  return gitExecOptions(cwd, { ...options, signal: undefined })
}

async function verifyDiscardPreparationOwner(
  repoPath: string,
  worktreePath: string,
  expectedLockReason: string,
  options: GitExecOptionsForWorktree,
  originalLockPath?: string | null
): Promise<string | null> {
  try {
    const gitDir = dirname(
      await verifyWorktreePreparationLock(worktreePath, expectedLockReason, options)
    )
    if (originalLockPath) {
      await verifyOriginalPreparationDirectory(gitDir, originalLockPath)
    }
    await verifyWorktreePreparationLockAtPath(
      join(gitDir, 'locked'),
      expectedLockReason,
      options.signal
    )
    return gitDir
  } catch (error) {
    const hostPath = resolveWorktreeHostPath(worktreePath, options)
    const hostRepo = resolveWorktreeHostPath(repoPath, options)
    if (!hostPath || !hostRepo) {
      throw error
    }
    const signal = AbortSignal.timeout(options.timeout ?? WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS)
    const absent = await waitForPromiseWithSignal(
      lstat(toHostFilesystemPath(hostPath)),
      signal
    ).then(
      () => false,
      (failure: unknown) => {
        if (getErrorCode(failure) === 'ENOENT') {
          return true
        }
        throw failure
      }
    )
    if (!absent) {
      throw error
    }
    const gitDir = await findLinkedWorktreeGitDirectory(hostRepo, hostPath, { ...options, signal })
    if (!gitDir) {
      if (
        originalLockPath === null ||
        (originalLockPath && (await pathAbsent(dirname(originalLockPath))))
      ) {
        return null
      }
      throw new WorktreePreparationLockOwnershipError(error)
    }
    if (originalLockPath) {
      await verifyOriginalPreparationDirectory(gitDir, originalLockPath)
    }
    const lockPath = toHostFilesystemPath(join(gitDir, 'locked'))
    const marker = await waitForPromiseWithSignal(lstat(lockPath), signal).catch(
      (failure: unknown) => {
        throw new WorktreePreparationLockOwnershipError(failure)
      }
    )
    if (!marker.isFile()) {
      throw new WorktreePreparationLockOwnershipError()
    }
    await waitForPromiseWithSignal(
      verifyWorktreePreparationLockAtPath(lockPath, expectedLockReason, signal),
      signal
    )
    return gitDir
  }
}

export type PreparationRemovalOutcome = 'removed' | 'skipped' | 'ownership-lost' | 'revoked'

async function pathAbsent(path: string, options: GitWorktreeExecOptions = {}): Promise<boolean> {
  const hostPath = resolveWorktreeHostPath(path, options)
  if (!hostPath) {
    throw new Error('Cannot resolve the prepared checkout path.')
  }
  return lstat(toHostFilesystemPath(hostPath)).then(
    () => false,
    (error: unknown) => {
      if (getErrorCode(error) === 'ENOENT') {
        return true
      }
      throw error
    }
  )
}

export type PreparationLocation = 'hidden' | 'target' | 'removed' | 'ownership-lost' | 'unknown'

/** Both pointers and the original marker must agree before failed finalization can remove a path. */
export async function reconcilePreparationLocation(
  lockPath: string,
  hiddenPath: string,
  targetPath: string,
  lockReason: string,
  options: GitWorktreeExecOptions
): Promise<PreparationLocation> {
  const gitDir = dirname(lockPath)
  const signal = AbortSignal.timeout(options.timeout ?? WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS)
  const read = <T>(work: Promise<T>): Promise<T> => waitForPromiseWithSignal(work, signal)
  try {
    const [hiddenAbsent, targetAbsent, adminAbsent] = await read(
      Promise.all([
        pathAbsent(hiddenPath, options),
        pathAbsent(targetPath, options),
        pathAbsent(gitDir)
      ])
    )
    if (hiddenAbsent && targetAbsent && adminAbsent) {
      return 'removed'
    }
    if (adminAbsent) {
      return 'unknown'
    }
    await read(verifyWorktreePreparationLockAtPath(lockPath, lockReason, signal))
    const backlink = await read(readFile(join(gitDir, 'gitdir'), 'utf8'))
    const gitFile = resolveGitMetadataPath(gitDir, backlink, options)
    if (!gitFile) {
      return 'unknown'
    }
    const path = dirname(gitFile)
    const key = async (value: string): Promise<string> =>
      canonicalWorktreePath(await read(realpath(toHostFilesystemPath(value))).catch(() => value))
    const hidden = resolveWorktreeHostPath(hiddenPath, options)
    const target = resolveWorktreeHostPath(targetPath, options)
    const location =
      hidden && (await key(path)) === (await key(hidden))
        ? 'hidden'
        : target && (await key(path)) === (await key(target))
          ? 'target'
          : undefined
    if (!location || (await key(gitFile)) !== (await key(join(path, '.git')))) {
      return 'unknown'
    }
    const pointer = await read(readFile(toHostFilesystemPath(gitFile), 'utf8'))
    const marker = parseGitdirMarkerPayload(pointer)
    const pointedAdmin = marker && resolveGitMetadataPath(path, marker, options)
    if (!pointedAdmin || (await key(pointedAdmin)) !== (await key(gitDir))) {
      return 'unknown'
    }
    await read(verifyWorktreePreparationLockAtPath(lockPath, lockReason, signal))
    return location
  } catch (error) {
    return error instanceof WorktreePreparationLockOwnershipError && error.replaced
      ? 'ownership-lost'
      : 'unknown'
  }
}

export async function performDiscardPreparedWorktree(
  repoPath: string,
  worktreePath: string,
  options: GitWorktreeExecOptions,
  expectedLockReason?: string,
  originalLockPath?: string | null
): Promise<PreparationRemovalOutcome> {
  const writers: Promise<void>[] = []
  const cleanupGitOptions = {
    ...gitCleanupOptions(repoPath, options),
    timeout: options.timeout ?? WORKTREE_REMOVAL_REGISTRATION_TIMEOUT_MS,
    observeChildTermination: (terminated: Promise<void>, writes: boolean) => {
      options.observeChildTermination?.(terminated, writes)
      if (writes) {
        writers.push(terminated)
      }
    }
  }
  try {
    let gitDir: string | null = null
    if (expectedLockReason !== undefined) {
      gitDir = await verifyDiscardPreparationOwner(
        repoPath,
        worktreePath,
        expectedLockReason,
        cleanupGitOptions,
        originalLockPath
      )
      if (gitDir === null) {
        return 'removed'
      }
    }
    if (cleanupGitOptions.canStart?.() === false) {
      return 'skipped'
    }
    // Double force requires a freshly verified ownership marker.
    await gitExecFileAsync(
      [
        ...windowsLongPathGitArgs(repoPath),
        'worktree',
        'remove',
        '--force',
        ...(expectedLockReason === undefined ? [] : ['--force']),
        worktreePath
      ],
      cleanupGitOptions
    )
    await Promise.allSettled(writers)
    if (!(await pathAbsent(worktreePath, options)) || (gitDir && !(await pathAbsent(gitDir)))) {
      throw new Error('The prepared checkout or its registration remains after removal.')
    }
    return 'removed'
  } finally {
    invalidateWslLinkedWorktreeGitRouting(worktreePath)
  }
}

export async function removeFailedFinalization(
  repoPath: string,
  cleanupPath: string,
  branch: string,
  moved: boolean,
  options: GitWorktreeExecOptions,
  expectedLockReason?: string,
  originalLockPath?: string
): Promise<boolean> {
  let branchAttached = false
  if (moved) {
    try {
      const { stdout } = await gitExecFileAsync(
        ['symbolic-ref', '--short', 'HEAD'],
        gitCleanupOptions(cleanupPath, options)
      )
      branchAttached = stdout.trim() === branch
    } catch {
      // Detached or no longer readable.
    }
  }
  const removed = await performDiscardPreparedWorktree(
    repoPath,
    cleanupPath,
    options,
    expectedLockReason,
    originalLockPath
  ).then(
    (outcome) => outcome === 'removed',
    () => false
  )
  if (!removed) {
    return false
  }
  if (branchAttached) {
    await gitExecFileAsync(
      ['branch', '-D', '--', branch],
      gitCleanupOptions(repoPath, options)
    ).catch(() => {})
  }
  return true
}

export async function discardPreparedWorktree(
  repoPath: string,
  worktreePath: string,
  options: GitWorktreeExecOptions = {},
  expectedLockReason?: string,
  originalLockPath?: string | null
): Promise<PreparationRemovalOutcome> {
  try {
    return await runWithGitReadCacheInvalidation(() =>
      performDiscardPreparedWorktree(
        repoPath,
        worktreePath,
        options,
        expectedLockReason,
        originalLockPath
      )
    )
  } finally {
    bumpWorktreeScanGeneration(repoPath)
  }
}
