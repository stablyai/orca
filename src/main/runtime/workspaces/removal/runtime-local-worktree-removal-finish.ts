import type { RuntimeRegisteredLocalWorktreeRemovalArgs } from './runtime-registered-local-worktree-removal'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import type { GitWorktreeInfo } from '../../../../shared/worktree/types'
import { removeWorktree } from '../../../git/worktrees/removal/worktree-removal'
import { usesNativeWindowsRemoval } from '../../../git/worktrees/removal/windows-worktree-removal'
import { CheckoutIdentityRefusal } from '../../../workspaces/removal/worktree-removal-leftover'
import { recoverPartialLocalWorktreeRemoval } from '../../../workspaces/removal/local-worktree-removal-recovery'
import { cleanupLocalOrphanedWorktreeDirectory } from '../../../workspaces/removal/local-orphaned-worktree-cleanup'
import { pruneGitWorktrees } from '../../../git/worktrees/removal/worktree-prune-guard'
import { cleanupRemovedWorktreePushTarget } from './runtime-worktree-push-target-cleanup'
import { runWorktreeChangeInvalidators } from '../../../ipc/worktrees/listing/worktree-change-invalidators'
import {
  formatWorktreeRemovalError,
  isOrphanedWorktreeError
} from '../../../ipc/worktrees/paths/worktree-logic'

export type RuntimeLocalWorktreeRemovalFinishArgs = Pick<
  RuntimeRegisteredLocalWorktreeRemovalArgs,
  | 'repo'
  | 'removedPushTarget'
  | 'store'
  | 'localOptions'
  | 'force'
  | 'deleteBranch'
  | 'closeWatchers'
  | 'preserveBranchHead'
  | 'finishRemoval'
  | 'expectation'
> & { target: { id: string } }

/** Git's delete and everything after it; the refusals and teardown before it already ran. */
export async function finishRuntimeLocalWorktreeRemoval(
  args: RuntimeLocalWorktreeRemovalFinishArgs,
  refreshed: GitWorktreeInfo,
  gate: { finish: (removed: boolean) => Promise<void> },
  checkoutDeleteSignal?: AbortSignal,
  beforeCheckoutDelete?: () => Promise<void>,
  markerOptions: { expectedMarker?: string; forbidAnyMarker?: boolean } = {}
): Promise<RemoveWorktreeResult> {
  const { repo, localOptions } = args
  const canonicalPath = refreshed.path
  const native = usesNativeWindowsRemoval(canonicalPath, localOptions)
  const hasInlineGuard =
    markerOptions.expectedMarker !== undefined || markerOptions.forbidAnyMarker === true
  let removalResult: RemoveWorktreeResult | undefined
  let completed = false
  try {
    try {
      removalResult = args.preserveBranchHead(
        await removeWorktree(repo.path, canonicalPath, args.force, {
          ...(!args.deleteBranch ? { deleteBranch: args.deleteBranch } : {}),
          knownRemovedWorktree: refreshed,
          ...localOptions,
          ...markerOptions,
          ...(checkoutDeleteSignal ? { checkoutDeleteSignal } : {}),
          ...(beforeCheckoutDelete ? { beforeCheckoutDelete } : {}),
          ...(args.expectation
            ? {
                checkoutDeleteIdentity: args.expectation.checkoutIdentity,
                checkoutDeleteGuard: () => args.expectation!.check(),
                onCheckoutDeleteStart: () => args.expectation!.joined()
              }
            : {})
        }),
        refreshed.head
      )
    } catch (error) {
      // A refused identity check deleted nothing; recovery must not delete someone else's folder.
      if (args.expectation || error instanceof CheckoutIdentityRefusal || native) {
        throw error
      }
      const recovered = await recoverPartialLocalWorktreeRemoval({
        error,
        force: args.force,
        canonicalWorktreePath: canonicalPath,
        repoPath: repo.path,
        localWorktreeGitOptions: localOptions,
        registeredWorktree: refreshed,
        deleteBranch: args.deleteBranch,
        closeWatcher: args.closeWatchers,
        signal: checkoutDeleteSignal,
        ...markerOptions,
        ...(!hasInlineGuard && beforeCheckoutDelete
          ? { beforeLeftoverDelete: beforeCheckoutDelete }
          : {})
      })
      if (recovered) {
        removalResult = recovered
        completed = true
      } else if (isOrphanedWorktreeError(error)) {
        await beforeCheckoutDelete?.()
        await cleanupLocalOrphanedWorktreeDirectory(
          repo.path,
          canonicalPath,
          localOptions,
          args.closeWatchers,
          checkoutDeleteSignal,
          markerOptions
        )
        await pruneGitWorktrees({ cwd: repo.path, ...localOptions }).catch(() => {})
        await cleanupRemovedWorktreePushTarget(args)
        await args.finishRemoval(undefined, false, refreshed.head)
        completed = true
        return {}
      } else {
        throw new Error(formatWorktreeRemovalError(error, canonicalPath, args.force))
      }
    }
    // Removal overtakes earlier scans; invalidate their catalogs.
    runWorktreeChangeInvalidators(repo.id)
    completed = true
    try {
      await cleanupRemovedWorktreePushTarget(args)
    } finally {
      // Awaited so the removal result lands only after the host-state purge (and
      // the Codex pretrust deletion inside it) has finished.
      await args.finishRemoval(removalResult, true, refreshed.head)
    }
    return removalResult ?? {}
  } finally {
    await gate.finish(completed)
  }
}
