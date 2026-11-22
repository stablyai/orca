import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import type { Repo } from '../../../../shared/repository/repo-types'
import { assertWorktreeUnlockedForRemoval } from '../../../../shared/worktree/removal/removal'
import type { LocalProjectWorktreeGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import {
  authorizeWindowsCheckout,
  usesNativeWindowsRemoval
} from '../../../git/worktrees/removal/windows-worktree-removal'
import { assertWorktreeCleanForRemoval } from '../../../git/worktrees/removal/worktree-removal-preflight'
import type { getWorktreeSharedLinkPaths } from '../../../git/worktrees/content-paths/worktree-shared-directories'
import { findExistingWorktreeSymlinkPaths } from '../../../git/worktrees/content-paths/worktree-symlink-detection'
import {
  formatWorktreeRemovalError,
  isOrphanCompatiblePreflightError
} from '../../../ipc/worktrees/paths/worktree-logic'

/** Lock and dirty-checkout refusals, which Git would also raise. */
export async function assertCheckoutRemovable(
  args: {
    repo: Repo
    localOptions: LocalProjectWorktreeGitOptions
    hasLocalOptions: boolean
    force: boolean
  },
  worktree: GitWorktreeInfo,
  linkedPaths: ReturnType<typeof getWorktreeSharedLinkPaths>,
  markerMissing: boolean
): Promise<void> {
  const { repo, localOptions } = args
  const canonicalPath = worktree.path
  try {
    assertWorktreeUnlockedForRemoval(worktree)
  } catch (error) {
    throw new Error(formatWorktreeRemovalError(error, canonicalPath, args.force))
  }

  const ignoredLinkedPaths = args.force
    ? []
    : await findExistingWorktreeSymlinkPaths(canonicalPath, linkedPaths)
  try {
    if (usesNativeWindowsRemoval(canonicalPath, localOptions)) {
      await authorizeWindowsCheckout(
        repo.path,
        canonicalPath,
        args.force,
        {
          ...localOptions,
          knownRemovedWorktree: worktree,
          ignoredUntrackedPaths: ignoredLinkedPaths
        },
        true
      )
    } else if (!markerMissing) {
      await (args.hasLocalOptions
        ? assertWorktreeCleanForRemoval(canonicalPath, args.force, {
            ...localOptions,
            ...(ignoredLinkedPaths.length > 0 ? { ignoredUntrackedPaths: ignoredLinkedPaths } : {})
          })
        : ignoredLinkedPaths.length > 0
          ? assertWorktreeCleanForRemoval(canonicalPath, args.force, {
              ignoredUntrackedPaths: ignoredLinkedPaths
            })
          : assertWorktreeCleanForRemoval(canonicalPath, args.force))
    }
  } catch (error) {
    if (!isOrphanCompatiblePreflightError(error)) {
      throw new Error(formatWorktreeRemovalError(error, canonicalPath, args.force))
    }
  }
}
