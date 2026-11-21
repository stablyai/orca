import { archiveHookRanFrom } from '../../../../shared/worktree/removal/archive-hook-decision'
import { worktreeRemovalLifetime } from '../../../workspaces/removal/worktree-removal-lifetime'
import { readCheckoutMarkerIdentity } from '../../../workspaces/removal/worktree-removal-gitdir-identity'
import { CheckoutIdentityRefusal } from '../../../workspaces/removal/worktree-removal-leftover'
import type { GitPushTarget, GitWorktreeInfo } from '../../../../shared/worktree/types'
import {
  nativeWindowsMarkerMissing,
  usesNativeWindowsRemoval
} from '../../../git/worktrees/removal/windows-worktree-removal'
import { pruneGitWorktrees } from '../../../git/worktrees/removal/worktree-prune-guard'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import type { ArchiveHookOverride } from '../../../../shared/worktree/removal/archive-hook-removal-gate'
import { gateWorktreeRemovalOnArchiveHook } from '../../../workspaces/removal/worktree-archive-hook-gate'
import type { Repo } from '../../../../shared/repository/repo-types'
import type { LocalProjectWorktreeGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import { listWorktreesStrict } from '../../../git/worktrees/catalog/worktree-listing'
import { removeWorktree } from '../../../git/worktrees/removal/worktree-removal'
import { getWorktreeSharedLinkPaths } from '../../../git/worktrees/content-paths/worktree-shared-directories'
import { runHook } from '../../../workspace-hooks/hooks'
import { loadArchiveHooksForRemoval } from '../../../workspace-hooks/archive-hook-trust-content'
import { removeWorktreeLinkedPaths } from '../../../ipc/worktrees/linked-paths/worktree-symlinks'
import { cleanupRemovedWorktreePushTarget } from './runtime-worktree-push-target-cleanup'
export { cleanupRemovedWorktreePushTarget } from './runtime-worktree-push-target-cleanup'
import { runWorktreeChangeInvalidators } from '../../../ipc/worktrees/listing/worktree-change-invalidators'
import {
  formatWorktreeRemovalError,
  isOrphanedWorktreeError
} from '../../../ipc/worktrees/paths/worktree-logic'
import { cleanupLocalOrphanedWorktreeDirectory } from '../../../workspaces/removal/local-orphaned-worktree-cleanup'
import { recoverPartialLocalWorktreeRemoval } from '../../../workspaces/removal/local-worktree-removal-recovery'
import { findRegisteredDeletableWorktree } from '../../../workspaces/removal/worktree-removal-safety'
import { CLIENT_REMOVAL_HOME } from '../../../workspaces/removal/worktree-removal-home-guard'
import type { RuntimePreservedBranchCleanup } from '../../repositories/runtime-preserved-branch-cleanup'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type {
  ArchiveHookRemovalOptions,
  RuntimeWorktreeRemovalTarget
} from '../catalog/runtime-worktree-selection'
import {
  removesInBackground,
  startBackgroundWorktreeRemoval,
  waitForPendingWorktreeRemoval,
  waitForWorktreeRemovalAcceptance
} from '../../../workspaces/removal/worktree-background-removal'
import { runSerializedWorktreeRemovalAcceptance } from '../../../workspaces/removal/worktree-removal-acceptance-queue'
import { assertCheckoutRemovable } from './registered-worktree-removal-checkout-checks'

/** Runs after the previous same-repo removal was accepted; see runSerializedWorktreeRemovalAcceptance. */
export function removeRuntimeRegisteredLocalWorktree(
  args: RegisteredLocalWorktreeRemovalArgs
): Promise<RemoveWorktreeResult & { warning?: string }> {
  return runSerializedWorktreeRemovalAcceptance(
    args.repo.path,
    async (): Promise<RemoveWorktreeResult & { warning?: string }> => {
      // Recheck after queue wait: another client may already have accepted this deletion.
      if (waitForPendingWorktreeRemoval(args.target.id, undefined, args.requestedDeleteBranch)) {
        await waitForWorktreeRemovalAcceptance(args.target.id)
        return { removing: true }
      }
      // Held from before the archive hook: quitting mid-hook must not strand a half-torn-down checkout.
      return removesInBackground(args.registeredWorktree.path, args.localOptions)
        ? worktreeRemovalLifetime.withPreparation(() =>
            acceptRuntimeRegisteredLocalWorktreeRemoval(args)
          )
        : acceptRuntimeRegisteredLocalWorktreeRemoval(args)
    }
  )
}

type RegisteredLocalWorktreeRemovalArgs = Parameters<
  typeof acceptRuntimeRegisteredLocalWorktreeRemoval
>[0]

async function acceptRuntimeRegisteredLocalWorktreeRemoval(args: {
  repo: Repo
  target: RuntimeWorktreeRemovalTarget
  registeredWorktree: GitWorktreeInfo
  removedPushTarget: GitPushTarget | undefined
  store: RuntimeStore
  localOptions: LocalProjectWorktreeGitOptions
  hasLocalOptions: boolean
  force: boolean
  /** allowFailedArchiveHook waives a FAILED hook, never implied by `force` (#19334). */
  archiveHook: ArchiveHookRemovalOptions
  allowUnverifiedPtyStop: boolean
  deleteBranch: boolean
  /** Legacy callers join accepted policy; explicit requests must match it. */
  requestedDeleteBranch?: boolean
  acquireWatcherRemoval: (path: string) => Promise<{ finish: (removed: boolean) => Promise<void> }>
  stopPtys: () => Promise<void>
  /** Runs after every refusal and the teardown, before any checkout file is deleted. */
  beforeCheckoutDelete?: (worktree: GitWorktreeInfo) => Promise<void>
  closeWatchers: (path: string) => Promise<void>
  preserveBranchHead: RuntimePreservedBranchCleanup['preserveHead']
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
  const hooks = await loadArchiveHooksForRemoval(repo, args.archiveHook)
  let warning: string | undefined
  // Archive refusal precedes refresh, PTY stop and Git deletion; failure must leave them untouched (#19334).
  let archiveHookOverride: ArchiveHookOverride | undefined
  let archiveHookRan: boolean | null = false
  const linkedPaths = getWorktreeSharedLinkPaths(repo)
  const markerMissing = await nativeWindowsMarkerMissing(canonicalPath, localOptions)
  if (hooks?.scripts.archive && args.archiveHook.runHooks === true && !markerMissing) {
    // A hook that releases resources must not run for a delete the checks below would refuse.
    await assertCheckoutRemovable(args, registeredWorktree, linkedPaths, markerMissing)
    const result = await runHook(
      'archive',
      canonicalPath,
      repo,
      undefined,
      args.hasLocalOptions ? localOptions : undefined,
      { identity: { worktreeId: args.target.id }, hooks }
    )
    archiveHookRan = archiveHookRanFrom(result)
    archiveHookOverride = gateWorktreeRemovalOnArchiveHook({
      worktreePath: canonicalPath,
      result,
      allowFailure: args.archiveHook.allowFailedArchiveHook === true
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
  await assertCheckoutRemovable(args, refreshed, linkedPaths, markerMissing)

  const background = removesInBackground(canonicalPath, localOptions)
  const prepare = async (): Promise<RemoveWorktreeResult> => {
    const gate = await args.acquireWatcherRemoval(canonicalPath)
    let accepted = false
    try {
      await args.stopPtys()
      await args.beforeCheckoutDelete?.(refreshed)
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
      archiveHookRan,
      ...(warning ? { warning } : {})
    }
    if (!background) {
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
        gitdir: await readCheckoutMarkerIdentity(refreshed.path),
        deleteBranch: args.deleteBranch,
        force: args.force
      },
      run: async (stopSignal) => {
        const result = await finishRuntimeLocalWorktreeRemoval(args, refreshed, gate, stopSignal)
        args.onRemoved()
        // A request joining this delete later still learns whether the hook ran.
        return { ...result, archiveHookRan }
      },
      publish: () => args.publish(),
      admissionFailed: () => gate.finish(false)
    })
    await waitForWorktreeRemovalAcceptance(args.target.id)
    return { removing: true, ...acceptedFields }
  }
  return prepare()
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
  checkoutDeleteSignal?: AbortSignal,
  beforeCheckoutDelete?: () => Promise<void>
): Promise<RemoveWorktreeResult> {
  const { repo, localOptions } = args
  const canonicalPath = refreshed.path
  const native = usesNativeWindowsRemoval(canonicalPath, localOptions)
  let removalResult: RemoveWorktreeResult | undefined
  let completed = false
  try {
    try {
      removalResult = args.preserveBranchHead(
        await removeWorktree(repo.path, canonicalPath, args.force, {
          ...(!args.deleteBranch ? { deleteBranch: args.deleteBranch } : {}),
          knownRemovedWorktree: refreshed,
          ...localOptions,
          ...(checkoutDeleteSignal ? { checkoutDeleteSignal } : {}),
          ...(beforeCheckoutDelete ? { beforeCheckoutDelete } : {})
        }),
        refreshed.head
      )
    } catch (error) {
      // A refused identity check deleted nothing; recovery must not delete someone else's folder.
      if (error instanceof CheckoutIdentityRefusal || native) {
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
        ...(beforeCheckoutDelete ? { beforeLeftoverDelete: beforeCheckoutDelete } : {})
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
          checkoutDeleteSignal
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
