import type { GitPushTarget, GitWorktreeInfo } from '../../shared/worktree/types'
import { markWorktreeMembershipDirty } from '../git/worktree-membership/worktree-membership-store'
import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import type { ArchiveHookOverride } from '../../shared/worktree/archive-hook-removal-gate'
import { gateWorktreeRemovalOnArchiveHook } from '../worktree-archive-hook-gate'
import type { Repo } from '../../shared/repo-types'
import { assertWorktreeUnlockedForRemoval } from '../../shared/worktree/removal'
import type { LocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import { gitExecFileAsync } from '../git/runner'
import { assertWorktreeCleanForRemoval, listWorktreesStrict, removeWorktree } from '../git/worktree'
import { getWorktreeSharedLinkPaths } from '../git/worktree-shared-directories'
import { runHook, getEffectiveHooks } from '../hooks'
import {
  findExistingWorktreeSymlinkPaths,
  removeWorktreeLinkedPaths
} from '../ipc/worktree-symlinks'
import { cleanupUnusedWorktreePushTargetRemote } from '../ipc/worktree-remote'
import { runWorktreeChangeInvalidators } from '../ipc/worktree-change-invalidators'
import {
  formatWorktreeRemovalError,
  isOrphanCompatiblePreflightError,
  isOrphanedWorktreeError
} from '../ipc/worktree-logic'
import { cleanupLocalOrphanedWorktreeDirectory } from '../local-orphaned-worktree-cleanup'
import { recoverLocalWindowsWorktreeRemoval } from '../local-worktree-removal-recovery'
import { findRegisteredDeletableWorktree } from '../worktree-removal-safety'
import { CLIENT_REMOVAL_HOME } from '../worktree-removal-home-guard'
import type { RuntimeStore } from './runtime-store-contract'
import type { RuntimeWorktreeRemovalTarget } from './runtime-worktree-selection'
import {
  removesInBackground,
  startBackgroundWorktreeRemoval,
  waitForPendingWorktreeRemoval
} from '../worktree-background-removal'
import { runSerializedWorktreeRemovalAcceptance } from '../worktree-removal-acceptance-queue'

/** Runs after the previous same-repo removal was accepted; see runSerializedWorktreeRemovalAcceptance. */
export function removeRuntimeRegisteredLocalWorktree(
  args: Parameters<typeof acceptRuntimeRegisteredLocalWorktreeRemoval>[0]
): Promise<RemoveWorktreeResult & { warning?: string }> {
  return runSerializedWorktreeRemovalAcceptance(
    args.repo.path,
    async (): Promise<RemoveWorktreeResult & { warning?: string }> =>
      // Why: another client's removal of this worktree may have been accepted during the wait.
      waitForPendingWorktreeRemoval(args.target.id)
        ? { removing: true }
        : acceptRuntimeRegisteredLocalWorktreeRemoval(args)
  )
}

async function acceptRuntimeRegisteredLocalWorktreeRemoval(args: {
  repo: Repo
  target: RuntimeWorktreeRemovalTarget
  registeredWorktree: GitWorktreeInfo
  removedPushTarget: GitPushTarget | undefined
  store: RuntimeStore
  localOptions: LocalProjectWorktreeGitOptions
  hasLocalOptions: boolean
  force: boolean
  runHooks: boolean
  /** Explicit waiver for a FAILED archive hook. Never implied by `force` — see #19334. */
  allowFailedArchiveHook: boolean
  allowUnverifiedPtyStop: boolean
  deleteBranch: boolean
  acquireWatcherRemoval: (path: string) => Promise<{ finish: (removed: boolean) => Promise<void> }>
  stopPtys: () => Promise<void>
  closeWatchers: (path: string) => Promise<void>
  preserveBranchHead: (
    result: RemoveWorktreeResult | undefined,
    fallbackHead: string | undefined
  ) => RemoveWorktreeResult
  finishRemoval: (
    result: RemoveWorktreeResult | undefined,
    rememberBranch: boolean,
    // Why: re-read after the archive hook, which can move the branch out from under the pre-hook row.
    fallbackHead: string | undefined
  ) => void
  /** Fired when Git finished, not on acceptance. */
  onRemoved: () => void
  publish: () => void
}): Promise<RemoveWorktreeResult & { warning?: string }> {
  const { repo, registeredWorktree, localOptions } = args
  const canonicalPath = registeredWorktree.path
  const hooks = getEffectiveHooks(repo)
  let warning: string | undefined
  // Precondition, not an advisory: this runs before the registration refresh, the preflights, the
  // PTY stop and `removeWorktree`, so a throw here leaves every one of them untouched (#19334).
  let archiveHookOverride: ArchiveHookOverride | undefined
  if (hooks?.scripts.archive && args.runHooks) {
    const result = await runHook(
      'archive',
      canonicalPath,
      repo,
      undefined,
      args.hasLocalOptions ? localOptions : undefined
    )
    archiveHookOverride = gateWorktreeRemovalOnArchiveHook({
      worktreePath: canonicalPath,
      result,
      allowFailure: args.allowFailedArchiveHook
    })
  } else if (hooks?.scripts.archive) {
    warning = `orca.yaml archive hook skipped for ${canonicalPath}; pass --run-hooks to run it.`
    console.warn(`[hooks] ${warning}`)
  }

  const refreshedWorktrees = args.hasLocalOptions
    ? await listWorktreesStrict(repo.path, localOptions)
    : await listWorktreesStrict(repo.path)
  const refreshed = findRegisteredDeletableWorktree(
    repo.path,
    canonicalPath,
    refreshedWorktrees,
    CLIENT_REMOVAL_HOME
  )
  if (!refreshed) {
    throw new Error(
      `Worktree registration changed during deletion: ${canonicalPath}. Retry deletion.`
    )
  }
  try {
    assertWorktreeUnlockedForRemoval(refreshed)
  } catch (error) {
    throw new Error(formatWorktreeRemovalError(error, canonicalPath, args.force))
  }

  const linkedPaths = getWorktreeSharedLinkPaths(repo)
  const ignoredLinkedPaths = args.force
    ? []
    : await findExistingWorktreeSymlinkPaths(canonicalPath, linkedPaths)
  try {
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
  } catch (error) {
    if (!isOrphanCompatiblePreflightError(error)) {
      throw new Error(formatWorktreeRemovalError(error, canonicalPath, args.force))
    }
  }

  const gate = await args.acquireWatcherRemoval(canonicalPath)
  let accepted = false
  try {
    await args.stopPtys()
    if (linkedPaths.length > 0) {
      await removeWorktreeLinkedPaths(canonicalPath, linkedPaths)
    }
    accepted = true
  } finally {
    if (!accepted) {
      await gate.finish(false)
    }
  }
  const acceptedFields = {
    ...(archiveHookOverride ? { archiveHookOverride } : {}),
    ...(warning ? { warning } : {})
  }
  if (!removesInBackground(canonicalPath, localOptions)) {
    const result = await finishRuntimeLocalWorktreeRemoval(args, refreshed, gate)
    args.publish()
    return { ...result, ...acceptedFields }
  }
  // Why detached: every refusal above already ran, and Git's 20-35 s delete must finish even when the
  // request that asked for it times out; other views read the host's `removing` marker meanwhile.
  void startBackgroundWorktreeRemoval({
    removal: {
      worktreeId: args.target.id,
      repoId: repo.id,
      repoPath: repo.path,
      worktree: refreshed,
      deleteBranch: args.deleteBranch,
      force: args.force
    },
    run: async (stopSignal) => {
      const result = await finishRuntimeLocalWorktreeRemoval(args, refreshed, gate, stopSignal)
      args.onRemoved()
      return result
    },
    publish: () => args.publish()
  })
  return { removing: true, ...acceptedFields }
}

export type RuntimeLocalWorktreeRemovalFinishArgs = Pick<
  Parameters<typeof acceptRuntimeRegisteredLocalWorktreeRemoval>[0],
  | 'repo'
  | 'removedPushTarget'
  | 'store'
  | 'localOptions'
  | 'force'
  | 'deleteBranch'
  | 'closeWatchers'
  | 'preserveBranchHead'
  | 'finishRemoval'
> & { target: { id: string } }

/** Git's delete and everything after it; the refusals and teardown before it already ran. */
export async function finishRuntimeLocalWorktreeRemoval(
  args: RuntimeLocalWorktreeRemovalFinishArgs,
  refreshed: GitWorktreeInfo,
  gate: { finish: (removed: boolean) => Promise<void> },
  checkoutDeleteSignal?: AbortSignal
): Promise<RemoveWorktreeResult> {
  const { repo, localOptions } = args
  const canonicalPath = refreshed.path
  let removalResult: RemoveWorktreeResult | undefined
  let completed = false
  try {
    try {
      removalResult = args.preserveBranchHead(
        await removeWorktree(repo.path, canonicalPath, args.force, {
          ...(!args.deleteBranch ? { deleteBranch: args.deleteBranch } : {}),
          knownRemovedWorktree: refreshed,
          ...localOptions,
          ...(checkoutDeleteSignal ? { checkoutDeleteSignal } : {})
        }),
        refreshed.head
      )
    } catch (error) {
      const recovered = await recoverLocalWindowsWorktreeRemoval({
        error,
        force: args.force,
        canonicalWorktreePath: canonicalPath,
        repoPath: repo.path,
        localWorktreeGitOptions: localOptions,
        registeredWorktree: refreshed,
        deleteBranch: args.deleteBranch,
        closeWatcher: args.closeWatchers
      })
      if (recovered) {
        removalResult = recovered
        completed = true
      } else if (isOrphanedWorktreeError(error)) {
        await cleanupLocalOrphanedWorktreeDirectory(
          repo.path,
          canonicalPath,
          localOptions,
          args.closeWatchers
        )
        await gitExecFileAsync(['worktree', 'prune'], { cwd: repo.path, ...localOptions }).catch(
          () => {}
        )
        markWorktreeMembershipDirty(repo.path)
        await cleanupRemovedWorktreePushTarget(args)
        args.finishRemoval(undefined, false, refreshed.head)
        completed = true
        return {}
      } else {
        throw new Error(formatWorktreeRemovalError(error, canonicalPath, args.force))
      }
    }
    // Why: the worktree is unlisted from here on; a scan that began before the removal is overtaken.
    runWorktreeChangeInvalidators(repo.id)
    completed = true
  } finally {
    await gate.finish(completed)
  }
  await cleanupRemovedWorktreePushTarget(args)
  args.finishRemoval(removalResult, true, refreshed.head)
  return removalResult ?? {}
}

export async function cleanupRemovedWorktreePushTarget(
  args: RuntimeLocalWorktreeRemovalFinishArgs
): Promise<void> {
  await cleanupUnusedWorktreePushTargetRemote(
    args.repo.path,
    args.target.id,
    args.removedPushTarget,
    args.store,
    args.localOptions
  )
}
