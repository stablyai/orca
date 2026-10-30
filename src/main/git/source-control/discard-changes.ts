import * as path from 'node:path'
import {
  removeSafeUntrackedDiscardTarget,
  removeSafeUntrackedDiscardTargets
} from '../../../shared/git-discard-path-safety'
import { partitionTrackedPathSpecs } from '../../../shared/git-tracked-pathspecs'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync } from '../runner'
import { invalidateGitReadCaches } from './git-read-cache-invalidation'
import { bulkPathspecCommands, literalPathspec } from './git-pathspec'
import { encodeGitPathspecs } from '../../../shared/git-pathspec-stdin'
import { redoWriteForDriveCheckoutSuspects } from './drive-checkout-suspect-writes'

const DISCARD_WRITE = ['restore', '--worktree'] as const

export async function discardChanges(
  worktreePath: string,
  filePath: string,
  options: GitRuntimeOptions = {}
): Promise<void> {
  invalidateGitReadCaches()
  const resolvedWorktree = path.resolve(worktreePath)
  const resolvedTarget = path.resolve(worktreePath, filePath)
  try {
    if (!isWithinWorktree(path, resolvedWorktree, resolvedTarget)) {
      throw new Error(`Path "${filePath}" resolves outside the worktree`)
    }

    let tracked = false
    try {
      await gitExecFileAsync(
        ['ls-files', '--error-unmatch', '--', literalPathspec(filePath, worktreePath, options)],
        {
          ...gitOptionsForWorktree(worktreePath, options)
        }
      )
      tracked = true
    } catch {}

    if (tracked) {
      await gitExecFileAsync(
        ['restore', '--worktree', '--', literalPathspec(filePath, worktreePath, options)],
        {
          ...gitOptionsForWorktree(worktreePath, options)
        }
      )
      await redoWriteForDriveCheckoutSuspects(worktreePath, [filePath], DISCARD_WRITE, options)
      return
    }

    await removeSafeUntrackedDiscardTarget(worktreePath, filePath, (targetPath) =>
      cleanUntrackedPaths(worktreePath, [targetPath], options)
    )
  } finally {
    invalidateGitReadCaches()
  }
}

async function listTrackedPathSpecs(
  worktreePath: string,
  filePaths: readonly string[],
  options: GitRuntimeOptions = {}
): Promise<string[]> {
  const trackedPaths: string[] = []
  const commands = bulkPathspecCommands(['ls-files', '-z', '--'], filePaths, worktreePath, options)
  for (const args of commands) {
    const { stdout } = await gitExecFileAsync(args, {
      ...gitOptionsForWorktree(worktreePath, options),
      // Fence WSL rc banners: a corrupted first NUL record could misclassify a tracked path as untracked.
      captureWslLoginShellOutput: true
    })
    // Iterate instead of spreading: tracked directories can exceed the JS argument limit.
    for (const trackedPath of stdout.split('\0')) {
      if (trackedPath) {
        trackedPaths.push(trackedPath)
      }
    }
  }
  return trackedPaths
}

async function cleanUntrackedPaths(
  worktreePath: string,
  filePaths: readonly string[],
  options: GitRuntimeOptions = {}
): Promise<void> {
  // Git pathspecs avoid recursive deletion through symlinked parents; empty chunks must never invoke clean.
  const commands = bulkPathspecCommands(['clean', '-ffdx', '--'], filePaths, worktreePath, options)
  for (const args of commands) {
    await gitExecFileAsync(args, { ...gitOptionsForWorktree(worktreePath, options) })
  }
}

export async function bulkDiscardChanges(
  worktreePath: string,
  filePaths: string[],
  options: GitRuntimeOptions = {}
): Promise<void> {
  invalidateGitReadCaches()
  if (filePaths.length === 0) {
    return
  }

  try {
    const resolvedWorktree = path.resolve(worktreePath)
    for (const filePath of filePaths) {
      const resolvedTarget = path.resolve(worktreePath, filePath)
      if (!isWithinWorktree(path, resolvedWorktree, resolvedTarget)) {
        throw new Error(`Path "${filePath}" resolves outside the worktree`)
      }
    }

    const trackedPathSpecs = await listTrackedPathSpecs(worktreePath, filePaths, options)
    const { trackedPaths, untrackedPaths } = partitionTrackedPathSpecs(filePaths, trackedPathSpecs)
    await removeSafeUntrackedDiscardTargets(
      worktreePath,
      untrackedPaths,
      (targetPaths) => cleanUntrackedPaths(worktreePath, targetPaths, options),
      async () => {
        if (trackedPaths.length === 0) {
          return
        }
        await gitExecFileAsync(
          ['restore', '--worktree', '--pathspec-from-file=-', '--pathspec-file-nul'],
          {
            ...gitOptionsForWorktree(worktreePath, options),
            stdin: encodeGitPathspecs(
              trackedPaths.map((filePath) => literalPathspec(filePath, worktreePath, options))
            )
          }
        )
        await redoWriteForDriveCheckoutSuspects(worktreePath, trackedPaths, DISCARD_WRITE, options)
      }
    )
  } finally {
    invalidateGitReadCaches()
  }
}

export function isWithinWorktree(
  pathApi: Pick<typeof path, 'isAbsolute' | 'relative' | 'sep'>,
  resolvedWorktree: string,
  resolvedTarget: string
): boolean {
  const relativeTarget = pathApi.relative(resolvedWorktree, resolvedTarget)
  return !(
    relativeTarget === '' ||
    relativeTarget === '..' ||
    relativeTarget.startsWith(`..${pathApi.sep}`) ||
    pathApi.isAbsolute(relativeTarget)
  )
}
