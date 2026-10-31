import { listWorktreesStrict } from '../../../git/worktree'
import { splitWorktreeIdForFilesystem } from '../../../../shared/worktree/id'
import { CLIENT_REMOVAL_HOME } from '../../../worktree-removal-home-guard'
import { revalidateRegisteredDeletableWorktree } from '../../../worktree-removal-safety'
import { assertRegisteredWorktreeRemovalApproval } from '../../../nested-worktree-removal-plan'
import type { RemoveWorktreeArgs } from '../ipc-context-schemas'
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

export async function refreshRegisteredLocalWorktreeForRemoval(
  repoPath: string,
  args: Pick<RemoveWorktreeArgs, 'worktreeId' | 'expectedCheckout'>,
  canonicalPath: string,
  localOptions: LocalProjectWorktreeGitOptions,
  hasLocalOptions: boolean
): Promise<GitWorktreeInfo> {
  const worktrees = hasLocalOptions
    ? await listWorktreesStrict(repoPath, localOptions)
    : await listWorktreesStrict(repoPath)
  const requestedPath = splitWorktreeIdForFilesystem(args.worktreeId)?.worktreePath ?? canonicalPath
  const refreshed = await revalidateRegisteredDeletableWorktree(
    repoPath,
    requestedPath,
    worktrees,
    CLIENT_REMOVAL_HOME,
    canonicalPath,
    localOptions
  )
  if (args.expectedCheckout) {
    assertRegisteredWorktreeRemovalApproval(refreshed, requestedPath, args.expectedCheckout)
  }
  return refreshed
}
