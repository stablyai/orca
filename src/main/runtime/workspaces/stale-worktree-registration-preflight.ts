import type { GitWorktreeInfo } from '../../../shared/worktree/types'
import type { WorktreeMeta } from '../../../shared/worktree/meta-types'
import type { LocalProjectWorktreeGitOptions } from '../../project-runtime-git-options'
import { assertWorktreeUnlockedForRemoval } from '../../../shared/worktree/removal'
import { formatWorktreeRemovalError } from '../../ipc/worktree-logic'
import { usesNativeWindowsRemoval } from '../../git/windows-worktree-removal'
import { isPrunableGitFileWorktree } from '../../worktree-prunable-git-file'
import { isWindowsAbsolutePathLike } from '../../../shared/cross-platform-path'
import { isLocalRuntimeWorktreePathMissing } from '../runtime-worktree-filesystem'

export async function isStaleLocalWorktreeRegistration(
  registeredWorktree: GitWorktreeInfo,
  force: boolean,
  removedMeta: WorktreeMeta | undefined,
  localWorktreeGitOptions: LocalProjectWorktreeGitOptions
): Promise<boolean | undefined> {
  const canonicalWorktreePath = registeredWorktree.path
  try {
    assertWorktreeUnlockedForRemoval(registeredWorktree)
  } catch (error) {
    throw new Error(formatWorktreeRemovalError(error, canonicalWorktreePath, force))
  }
  return (
    !usesNativeWindowsRemoval(canonicalWorktreePath, localWorktreeGitOptions) &&
    ((await isPrunableGitFileWorktree(registeredWorktree, localWorktreeGitOptions)) ||
      (force === true &&
        process.platform === 'win32' &&
        (isWindowsAbsolutePathLike(canonicalWorktreePath) || !!localWorktreeGitOptions.wslDistro) &&
        removedMeta &&
        (await isLocalRuntimeWorktreePathMissing(canonicalWorktreePath, localWorktreeGitOptions))))
  )
}
