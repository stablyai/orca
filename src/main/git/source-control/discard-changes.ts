import * as path from 'node:path'
import {
  removeSafeUntrackedDiscardTarget,
  removeSafeUntrackedDiscardTargets
} from '../../../shared/git-discard-path-safety'
import type { GitRuntimeOptions } from '../git-runtime-options'
import { gitOptionsForWorktree } from '../git-runtime-options'
import { gitExecFileAsync } from '../runner'
import { invalidateGitReadCaches } from './git-read-cache-invalidation'
import { BULK_CHUNK_SIZE, isTrackedPathSpec, literalPathspec } from './git-pathspec'

/**
 * Discard working tree changes for a file.
 */
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
        ['ls-files', '--error-unmatch', '--', literalPathspec(filePath, options)],
        {
          ...gitOptionsForWorktree(worktreePath, options)
        }
      )
      tracked = true
    } catch {
      // File is not tracked by git
    }

    if (tracked) {
      await gitExecFileAsync(
        ['restore', '--worktree', '--source=HEAD', '--', literalPathspec(filePath, options)],
        {
          ...gitOptionsForWorktree(worktreePath, options)
        }
      )
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
  for (let i = 0; i < filePaths.length; i += BULK_CHUNK_SIZE) {
    const chunk = filePaths.slice(i, i + BULK_CHUNK_SIZE)
    const { stdout } = await gitExecFileAsync(
      ['ls-files', '-z', '--', ...chunk.map((filePath) => literalPathspec(filePath, options))],
      {
        ...gitOptionsForWorktree(worktreePath, options)
      }
    )
    // Why: a tracked directory can hold enough paths to exceed the JS argument limit.
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
  for (let i = 0; i < filePaths.length; i += BULK_CHUNK_SIZE) {
    const chunk = filePaths.slice(i, i + BULK_CHUNK_SIZE)
    if (chunk.length > 0) {
      // Why: Git pathspec cleanup avoids raw recursive deletion through symlinked parents.
      await gitExecFileAsync(
        ['clean', '-ffdx', '--', ...chunk.map((filePath) => literalPathspec(filePath, options))],
        {
          ...gitOptionsForWorktree(worktreePath, options)
        }
      )
    }
  }
}

/**
 * Discard working tree changes for many paths in a small number of subprocesses.
 */
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
    const trackedPaths = filePaths.filter((filePath) =>
      isTrackedPathSpec(filePath, trackedPathSpecs)
    )
    const untrackedPaths = filePaths.filter(
      (filePath) => !isTrackedPathSpec(filePath, trackedPathSpecs)
    )
    await removeSafeUntrackedDiscardTargets(
      worktreePath,
      untrackedPaths,
      (targetPaths) => cleanUntrackedPaths(worktreePath, targetPaths, options),
      async () => {
        for (let i = 0; i < trackedPaths.length; i += BULK_CHUNK_SIZE) {
          const chunk = trackedPaths.slice(i, i + BULK_CHUNK_SIZE)
          await gitExecFileAsync(
            [
              'restore',
              '--worktree',
              '--source=HEAD',
              '--',
              ...chunk.map((filePath) => literalPathspec(filePath, options))
            ],
            {
              ...gitOptionsForWorktree(worktreePath, options)
            }
          )
        }
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
