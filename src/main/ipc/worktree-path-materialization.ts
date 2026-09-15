import { realpath, stat } from 'node:fs/promises'
import { isDescendantOrEqual, normalizeExistingPath } from './filesystem-path-containment'
import { resolve } from 'node:path'
import {
  resolveWorktreeCopySelection,
  collapseWorktreePaths,
  worktreePathsOverlap
} from '../git/worktree-copy-selection'
import { assertWorktreeMaterializationTarget } from './worktree-materialization-target'
import { resolveWorktreeIncludePaths } from '../git/worktree-include-file'
import { resolveWorktreeSharedDirectories } from '../git/worktree-shared-directories'
import type { WorktreeCreateTimingRecorder } from '../worktree-create-timing'
import { formatWorktreeIncludeCopyWarning } from './worktree-include-copy-budget'
import {
  createWorktreeCopiedPaths,
  createWorktreeLinkedPaths,
  createWorktreeSharedPaths
} from './worktree-symlinks'

/** Omitted copyPaths preserves the v1 host contract for older callers. */
export async function materializeHostWorktreePaths(
  source: string,
  target: string,
  linkedPaths: readonly string[],
  time: WorktreeCreateTimingRecorder['time'] = (_phase, operation) => operation(),
  copyPaths?: readonly string[]
): Promise<string | undefined> {
  if (copyPaths !== undefined) {
    return materializeSelectedWorktreePaths(source, target, linkedPaths, copyPaths, time)
  }
  if (linkedPaths.length) {
    await time('create_symlinks', () => createWorktreeLinkedPaths(source, target, linkedPaths))
  }
  const [sharedPaths, includePaths] = await Promise.all([
    time('resolve_shared_directories', () => resolveWorktreeSharedDirectories(source)),
    time('resolve_worktreeinclude', () => resolveWorktreeIncludePaths(source))
  ])
  if (sharedPaths.length) {
    await time('create_shared_directories', () =>
      createWorktreeSharedPaths(source, target, sharedPaths)
    )
  }
  if (!includePaths.length) {
    return undefined
  }
  const skipped = await time('copy_worktreeinclude', () =>
    createWorktreeCopiedPaths(source, target, includePaths)
  )
  const warning = formatWorktreeIncludeCopyWarning(skipped)
  if (warning) {
    console.warn(`[worktree-include] ${warning}`)
  }
  return warning
}

async function materializeSelectedWorktreePaths(
  source: string,
  target: string,
  legacyPaths: readonly string[],
  personalPaths: readonly string[],
  time: WorktreeCreateTimingRecorder['time']
): Promise<string | undefined> {
  const [selection, sharedPaths] = await Promise.all([
    resolveWorktreeCopySelection(source, personalPaths),
    resolveWorktreeSharedDirectories(source)
  ])
  const linkSources = await Promise.all(
    [...sharedPaths, ...legacyPaths].map(async (path) => ({
      path,
      canonical: await normalizeExistingPath(resolve(source, path))
    }))
  )
  for (const path of selection.paths) {
    const sourcePath = await realpath(resolve(source, path))
    const conflict = linkSources.find(
      (other) =>
        worktreePathsOverlap(source, path, other.path) ||
        worktreePathsOverlap(source, sourcePath, other.canonical)
    )?.path
    if (conflict) {
      throw new Error(
        `Cannot copy "${path}": it overlaps shared or legacy path "${conflict}". Resolve the configuration before preparing this worktree.`
      )
    }
    await assertWorktreeMaterializationTarget(target, resolve(target, path))
    if (
      (await stat(sourcePath)).isDirectory() &&
      isDescendantOrEqual(resolve(target, path), sourcePath)
    ) {
      throw new Error(`Cannot copy "${path}" into itself. Choose a different worktree location.`)
    }
  }
  await time('create_symlinks', () => createWorktreeLinkedPaths(source, target, legacyPaths))
  await time('create_shared_directories', () =>
    createWorktreeSharedPaths(source, target, collapseWorktreePaths(source, sharedPaths))
  )
  const skipped = await time('copy_worktreeinclude', () =>
    createWorktreeCopiedPaths(source, target, selection.paths)
  )
  const warning = formatWorktreeIncludeCopyWarning(skipped, undefined, 'Files to copy')
  if (skipped.some((entry) => entry.mayBePartial)) {
    throw new Error(
      `Workspace remains at "${target}". Copying may be incomplete; setup was not prepared. Inspect the destination before retrying. ${warning ?? ''}`
    )
  }
  return [...selection.notices, warning].filter(Boolean).join(' ') || undefined
}
