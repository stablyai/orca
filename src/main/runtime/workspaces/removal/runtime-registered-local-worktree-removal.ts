import { finishRuntimeLocalWorktreeRemoval } from './runtime-local-worktree-removal-finish'
export {
  finishRuntimeLocalWorktreeRemoval,
  type RuntimeLocalWorktreeRemovalFinishArgs
} from './runtime-local-worktree-removal-finish'
import { worktreeRemovalLifetime } from '../../../workspaces/removal/worktree-removal-lifetime'
import { readCheckoutMarkerIdentity } from '../../../workspaces/removal/worktree-removal-gitdir-identity'
import type { GitPushTarget, GitWorktreeInfo } from '../../../../shared/worktree/types'
import {
  authorizeWindowsCheckout,
  nativeWindowsMarkerMissing,
  usesNativeWindowsRemoval
} from '../../../git/worktrees/removal/windows-worktree-removal'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import type { ArchiveHookOverride } from '../../../../shared/worktree/removal/archive-hook-removal-gate'
import { gateWorktreeRemovalOnArchiveHook } from '../../../workspaces/removal/worktree-archive-hook-gate'
import type { Repo } from '../../../../shared/repository/repo-types'
import { assertWorktreeUnlockedForRemoval } from '../../../../shared/worktree/removal/removal'
import type { LocalProjectWorktreeGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import { assertWorktreeCleanForRemoval } from '../../../git/worktrees/removal/worktree-removal-preflight'
import { listWorktreesStrict } from '../../../git/worktrees/catalog/worktree-listing'
import { getWorktreeSharedLinkPaths } from '../../../git/worktrees/content-paths/worktree-shared-directories'
import { runHook, getEffectiveHooks } from '../../../workspace-hooks/hooks'
import { findExistingWorktreeSymlinkPaths } from '../../../git/worktrees/content-paths/worktree-symlink-detection'
import { removeWorktreeLinkedPaths } from '../../../ipc/worktrees/linked-paths/worktree-symlinks'
export { cleanupRemovedWorktreePushTarget } from './runtime-worktree-push-target-cleanup'
import {
  formatWorktreeRemovalError,
  isOrphanCompatiblePreflightError
} from '../../../ipc/worktrees/paths/worktree-logic'
import { findRegisteredDeletableWorktree } from '../../../workspaces/removal/worktree-removal-safety'
import { CLIENT_REMOVAL_HOME } from '../../../workspaces/removal/worktree-removal-home-guard'
import type { RuntimePreservedBranchCleanup } from '../../repositories/runtime-preserved-branch-cleanup'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { RuntimeWorktreeRemovalTarget } from '../catalog/runtime-worktree-selection'
import {
  removesInBackground,
  startBackgroundWorktreeRemoval,
  waitForPendingWorktreeRemoval,
  waitForWorktreeRemovalAcceptance
} from '../../../workspaces/removal/worktree-background-removal'
import { runSerializedWorktreeRemovalAcceptance } from '../../../workspaces/removal/worktree-removal-acceptance-queue'
import { withAcceptedCompletion } from '../../../workspaces/removal/worktree-removal-settlement'
import type { WorktreeRemovalExpectation } from '../../../workspaces/removal/worktree-removal-expectation'

/** Runs after the previous same-repo removal was accepted; see runSerializedWorktreeRemovalAcceptance. */
export function removeRuntimeRegisteredLocalWorktree(
  args: Parameters<typeof acceptRuntimeRegisteredLocalWorktreeRemoval>[0]
): Promise<RemoveWorktreeResult & { warning?: string }> {
  return runSerializedWorktreeRemovalAcceptance(
    args.repo.path,
    async (): Promise<RemoveWorktreeResult & { warning?: string }> => {
      args.expectation?.check()
      // Recheck after queue wait: another client may already have accepted this deletion.
      const pending = waitForPendingWorktreeRemoval(
        args.target.id,
        undefined,
        args.requestedDeleteBranch,
        args.expectation?.expected.instanceId
      )
      if (pending) {
        args.expectation?.joined()
        await waitForWorktreeRemovalAcceptance(args.target.id)
        return withAcceptedCompletion({ removing: true }, pending)
      }
      return acceptRuntimeRegisteredLocalWorktreeRemoval(args)
    }
  )
}

export type RuntimeRegisteredLocalWorktreeRemovalArgs = {
  expectation?: WorktreeRemovalExpectation
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
}

async function acceptRuntimeRegisteredLocalWorktreeRemoval(
  args: RuntimeRegisteredLocalWorktreeRemovalArgs
): Promise<RemoveWorktreeResult & { warning?: string }> {
  const { repo, registeredWorktree, localOptions } = args
  const canonicalPath = registeredWorktree.path
  await args.expectation?.bindCheckout(canonicalPath, repo.path)
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
      args.hasLocalOptions ? localOptions : undefined,
      { identity: { worktreeId: args.target.id } }
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

  const background = removesInBackground(canonicalPath, localOptions)
  const prepare = async (): Promise<RemoveWorktreeResult> => {
    const gate = await args.acquireWatcherRemoval(canonicalPath)
    let accepted = false
    try {
      await args.stopPtys()
      args.expectation?.check()
      await args.beforeCheckoutDelete?.(refreshed)
      args.expectation?.check()
      if (!markerMissing && linkedPaths.length > 0) {
        // Shared links live in the checkout: prove it's still the reviewed one before unlinking any.
        await args.expectation?.verifyCheckout(canonicalPath)
        args.expectation?.begin()
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
    if (!background) {
      const result = await finishRuntimeLocalWorktreeRemoval(args, refreshed, gate)
      args.publish()
      return { ...result, ...acceptedFields }
    }
    // After all refusals, detach slow Git deletion so request timeout cannot cancel it; clients follow the removing marker.
    const completion = startBackgroundWorktreeRemoval({
      removal: {
        worktreeId: args.target.id,
        repoId: repo.id,
        repoPath: repo.path,
        worktree: refreshed,
        gitdir: await readCheckoutMarkerIdentity(refreshed.path),
        deleteBranch: args.deleteBranch,
        force: args.force,
        ...(args.expectation
          ? {
              expectedInstanceId: args.expectation.expected.instanceId,
              expectedCheckoutIdentity: args.expectation.checkoutIdentity
            }
          : {})
      },
      run: async (stopSignal) => {
        const result = await finishRuntimeLocalWorktreeRemoval(args, refreshed, gate, stopSignal)
        args.onRemoved()
        return result
      },
      publish: () => args.publish(),
      admissionFailed: () => gate.finish(false)
    })
    await waitForWorktreeRemovalAcceptance(args.target.id)
    return withAcceptedCompletion({ removing: true, ...acceptedFields }, completion)
  }
  return background ? worktreeRemovalLifetime.withPreparation(prepare) : prepare()
}
