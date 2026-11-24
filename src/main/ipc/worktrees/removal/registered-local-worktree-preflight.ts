import type { Repo } from '../../../../shared/repository/repo-types'
import {
  assertWorktreeUnlockedForRemoval,
  CheckoutIdentityRefusal
} from '../../../../shared/worktree/removal/removal'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import { listWorktreesStrict } from '../../../git/worktrees/catalog/worktree-listing'
import { findExistingWorktreeSymlinkPaths } from '../../../git/worktrees/content-paths/worktree-symlink-detection'
import {
  authorizeWindowsCheckout,
  nativeWindowsMarkerMissing,
  usesNativeWindowsRemoval
} from '../../../git/worktrees/removal/windows-worktree-removal'
import { assertWorktreeCleanForRemoval } from '../../../git/worktrees/removal/worktree-removal-preflight'
import type { LocalProjectWorktreeGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import {
  captureAcceptedCheckoutGuard,
  type AcceptedCheckoutGuard
} from '../../../workspaces/removal/worktree-removal-gitdir-identity'
import { CLIENT_REMOVAL_HOME } from '../../../workspaces/removal/worktree-removal-home-guard'
import { findRegisteredDeletableWorktree } from '../../../workspaces/removal/worktree-removal-safety'
import {
  formatWorktreeRemovalError,
  isOrphanCompatiblePreflightError
} from '../paths/worktree-logic'

export async function prepareRegisteredLocalWorktreeRemoval(args: {
  repo: Repo
  canonicalWorktreePath: string
  force: boolean
  localOptions: LocalProjectWorktreeGitOptions
  hasLocalOptions: boolean
  linkedPaths: readonly string[]
  beforeUnlockCheck?: (refreshed: GitWorktreeInfo) => void
}): Promise<{
  refreshed: GitWorktreeInfo
  guard: AcceptedCheckoutGuard
  markerMissing: boolean
}> {
  const { repo, canonicalWorktreePath, force, localOptions, hasLocalOptions, linkedPaths } = args
  const refreshedWorktrees = hasLocalOptions
    ? await listWorktreesStrict(repo.path, localOptions)
    : await listWorktreesStrict(repo.path)
  const refreshed = findRegisteredDeletableWorktree(
    repo.path,
    canonicalWorktreePath,
    refreshedWorktrees,
    CLIENT_REMOVAL_HOME
  )
  if (!refreshed) {
    throw new Error(
      `Worktree registration changed during deletion: ${canonicalWorktreePath}. Retry deletion.`
    )
  }
  args.beforeUnlockCheck?.(refreshed)
  try {
    // Archive hooks can race external Git locks; recheck before destructive teardown.
    assertWorktreeUnlockedForRemoval(refreshed)
  } catch (error) {
    throw new Error(formatWorktreeRemovalError(error, canonicalWorktreePath, force))
  }
  const guard = await captureAcceptedCheckoutGuard(canonicalWorktreePath, localOptions)
  const ignoredLinkedPaths = force
    ? []
    : await findExistingWorktreeSymlinkPaths(canonicalWorktreePath, linkedPaths, localOptions)
  const markerMissing = await nativeWindowsMarkerMissing(canonicalWorktreePath, localOptions)
  await assertRegisteredLocalWorktreePreflight(
    repo.path,
    canonicalWorktreePath,
    refreshed,
    force,
    localOptions,
    hasLocalOptions,
    ignoredLinkedPaths,
    markerMissing,
    guard.markerOptions
  )
  return { refreshed, guard, markerMissing }
}

export async function assertRegisteredLocalWorktreePreflight(
  repoPath: string,
  canonicalWorktreePath: string,
  worktree: GitWorktreeInfo,
  force: boolean,
  localOptions: LocalProjectWorktreeGitOptions,
  hasLocalOptions: boolean,
  ignoredLinkedPaths: readonly string[],
  markerMissing: boolean,
  markerOptions: { expectedMarker?: string; forbidAnyMarker?: boolean } = {}
): Promise<void> {
  try {
    if (usesNativeWindowsRemoval(canonicalWorktreePath, localOptions)) {
      await authorizeWindowsCheckout(
        repoPath,
        canonicalWorktreePath,
        force,
        {
          ...localOptions,
          ...markerOptions,
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
    // A refusal names the path, which may itself contain text the orphan classifier matches.
    if (error instanceof CheckoutIdentityRefusal) {
      throw error
    }
    if (!isOrphanCompatiblePreflightError(error)) {
      throw new Error(formatWorktreeRemovalError(error, canonicalWorktreePath, force))
    }
    // Git may discover orphaning after preflight; recursive fallback still requires strict PTY teardown.
  }
}
