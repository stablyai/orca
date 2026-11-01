import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import type { LocalProjectWorktreeGitOptions } from '../../../project-runtime-git-options'
import {
  authorizeWindowsCheckout,
  usesNativeWindowsRemoval
} from '../../../git/windows-worktree-removal'
import { assertWorktreeCleanForRemoval } from '../../../git/worktree'
import { formatWorktreeRemovalError, isOrphanCompatiblePreflightError } from '../../worktree-logic'

export async function assertRegisteredLocalWorktreePreflight(
  repoPath: string,
  canonicalWorktreePath: string,
  worktree: GitWorktreeInfo,
  force: boolean,
  localOptions: LocalProjectWorktreeGitOptions,
  hasLocalOptions: boolean,
  ignoredLinkedPaths: readonly string[],
  markerMissing: boolean
): Promise<void> {
  try {
    if (usesNativeWindowsRemoval(canonicalWorktreePath, localOptions)) {
      await authorizeWindowsCheckout(
        repoPath,
        canonicalWorktreePath,
        force,
        {
          ...localOptions,
          knownRemovedWorktree: worktree,
          ignoredUntrackedPaths: ignoredLinkedPaths
        },
        true
      )
    } else if (!markerMissing) {
      await (hasLocalOptions
        ? assertWorktreeCleanForRemoval(canonicalWorktreePath, force, {
            ...localOptions,
            ...(ignoredLinkedPaths.length > 0 ? { ignoredUntrackedPaths: ignoredLinkedPaths } : {})
          })
        : ignoredLinkedPaths.length > 0
          ? assertWorktreeCleanForRemoval(canonicalWorktreePath, force, {
              ignoredUntrackedPaths: ignoredLinkedPaths
            })
          : assertWorktreeCleanForRemoval(canonicalWorktreePath, force))
    }
  } catch (error) {
    if (!isOrphanCompatiblePreflightError(error)) {
      throw new Error(formatWorktreeRemovalError(error, canonicalWorktreePath, force))
    }
    // Git may discover orphaning after preflight; recursive fallback still requires strict PTY teardown.
  }
}
