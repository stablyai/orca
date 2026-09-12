import { resolveWorktreeIncludePaths } from '../git/worktree-include-file'
import { resolveWorktreeSharedDirectories } from '../git/worktree-shared-directories'
import type { WorktreeCreateTimingRecorder } from '../worktree-create-timing'
import { formatWorktreeIncludeCopyWarning } from './worktree-include-copy-budget'
import {
  createWorktreeCopiedPaths,
  createWorktreeLinkedPaths,
  createWorktreeSharedPaths
} from './worktree-symlinks'

/** Run on the filesystem owner; configured paths take precedence over YAML and includes. */
export async function materializeHostWorktreePaths(
  source: string,
  target: string,
  linkedPaths: readonly string[],
  time: WorktreeCreateTimingRecorder['time'] = (_phase, operation) => operation()
): Promise<string | undefined> {
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
