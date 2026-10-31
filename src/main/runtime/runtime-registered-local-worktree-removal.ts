import type { GitPushTarget, GitWorktreeInfo } from '../../shared/worktree/types'
import {
  authorizeWindowsCheckout,
  nativeWindowsMarkerMissing,
  usesNativeWindowsRemoval
} from '../git/windows-worktree-removal'
import { pruneGitWorktrees } from '../git/worktree-prune-guard'
import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import type { ArchiveHookOverride } from '../../shared/worktree/archive-hook-removal-gate'
import { gateWorktreeRemovalOnArchiveHook } from '../worktree-archive-hook-gate'
import type { Repo } from '../../shared/repo-types'
import { assertWorktreeUnlockedForRemoval } from '../../shared/worktree/removal'
import type { LocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
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
import { recoverPartialLocalWorktreeRemoval } from '../local-worktree-removal-recovery'
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
      // Recheck after queue wait: another client may already have accepted this deletion.
      waitForPendingWorktreeRemoval(args.target.id, undefined, args.requestedDeleteBranch)
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
  /** Legacy callers join accepted policy; explicit requests must match it. */
  requestedDeleteBranch?: boolean
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
    // Archive hooks may move the branch; re-read the fallback head afterward.
    fallbackHead: string | undefined
  ) => void | Promise<void>
  /** Fired when Git finished, not on acceptance. */
  onRemoved: () => void
  publish: () => void
}): Promise<RemoveWorktreeResult & { warning?: string }> {
  const { repo, registeredWorktree, localOptions } = args
  const canonicalPath = registeredWorktree.path
  const hooks = getEffectiveHooks(repo)
  let warning: string | undefined
  // Archive refusal precedes refresh, preflights, PTY stop and Git deletion; failure must leave them untouched (#19334).
  let archiveHookOverride: ArchiveHookOverride | undefined
  if (
    hooks?.scripts.archive &&
    args.runHooks &&
    !(await nativeWindowsMarkerMissing(canonicalPath, localOptions))
  ) {
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
  const markerMissing = await nativeWindowsMarkerMissing(canonicalPath, localOptions)
  try {
    if (usesNativeWindowsRemoval(canonicalPath, localOptions)) {
      await authorizeWindowsCheckout(
        repo.path,
        canonicalPath,
        args.force,
        {
          ...localOptions,
          knownRemovedWorktree: refreshed,
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

  const gate = await args.acquireWatcherRemoval(canonicalPath)
  let accepted = false
  try {
    await args.stopPtys()
    if (!markerMissing && linkedPaths.length > 0) {
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
  // After all refusals, detach slow Git deletion so request timeout cannot cancel it; clients follow the removing marker.
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
    publish: () => args.publish(),
    cleanupPushTargetRemote: () => cleanupRemovedWorktreePushTarget(args)
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
      if (usesNativeWindowsRemoval(canonicalPath, localOptions)) {
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
        signal: checkoutDeleteSignal
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
  } finally {
    await gate.finish(completed)
  }
  await cleanupRemovedWorktreePushTarget(args)
  // Awaited so the removal result lands only after the host-state purge (and
  // the Codex pretrust deletion inside it) has finished.
  await args.finishRemoval(removalResult, true, refreshed.head)
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
