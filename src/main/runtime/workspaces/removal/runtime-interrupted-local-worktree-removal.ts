import {
  throwIfSignalAborted,
  waitForPromiseWithSignal
} from '../../../../shared/concurrency/abort-signal-reason'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import {
  releaseStartupRemovalFence,
  type BackgroundWorktreeRemovalJob
} from '../../../workspaces/removal/worktree-background-removal'
import {
  resolveWorktreeRemovalMetadata,
  resolveLocalWorktreeRemovalRepo
} from '../../../workspaces/removal/worktree-removal-repo-owner'
import { listWorktreesSharedStrict as listWorktreesStrict } from '../../../git/worktrees/catalog/worktree-scan-cache'
import {
  authorizeWindowsCheckout,
  usesNativeWindowsRemoval
} from '../../../git/worktrees/removal/windows-worktree-removal'
import {
  deleteBranchOfUnregisteredWorktree,
  finishUnregisteredWorktreeRemoval,
  removeWorktree
} from '../../../git/worktrees/removal/worktree-removal'
import { areWorktreePathsEqual } from '../../../git/worktrees/catalog/worktree-path-comparison'
import { getLocalProjectWorktreeGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import {
  findRegisteredDeletableWorktree,
  ORPHANED_WORKTREE_DIRECTORY_MESSAGE
} from '../../../workspaces/removal/worktree-removal-safety'
import {
  assertUnregisteredCheckoutGone,
  assertCheckoutNotReplaced,
  assertLeftoverIsRecordedCheckout,
  assertUnregisteredLeftoverRemovable,
  isLeftoverStillRemovable,
  recordedRootKey,
  removeEmptyLeftoverDirectory,
  isRecordedCheckout,
  differentCheckoutAtPathError
} from '../../../workspaces/removal/worktree-removal-leftover'
import { CLIENT_REMOVAL_HOME } from '../../../workspaces/removal/worktree-removal-home-guard'
import { isCheckoutMissingGitLink } from '../../../workspaces/removal/worktree-removal-gitdir-identity'
import { removeStaleLocalWorktreeRegistration } from '../../../workspaces/removal/local-worktree-removal-recovery'
import { removeLocalWorktreePath } from '../../../workspaces/removal/local-worktree-filesystem'
import type { WorktreeRemovalRecord } from '../../../workspaces/removal/worktree-removal-records'
import { WorktreeRemovalExpectation } from '../../../workspaces/removal/worktree-removal-expectation'
import {
  cleanupRemovedWorktreePushTarget,
  finishRuntimeLocalWorktreeRemoval,
  type RuntimeLocalWorktreeRemovalFinishArgs
} from './runtime-registered-local-worktree-removal'
import type {
  InterruptedLocalWorktreeRemovalArgs,
  InterruptedWorktreeRemovalHost
} from './runtime-interrupted-local-worktree-removal-types'
import { finishGoneCheckoutBookkeeping } from './runtime-interrupted-gone-checkout-removal'

/** The background job that finishes one interrupted removal on this host. */
export function interruptedLocalWorktreeRemovalJob(
  record: WorktreeRemovalRecord,
  host: InterruptedWorktreeRemovalHost
): BackgroundWorktreeRemovalJob {
  const expectation = record.expectedInstanceId
    ? new WorktreeRemovalExpectation(host.store, {
        worktreeId: record.worktreeId,
        instanceId: record.expectedInstanceId,
        checkoutIdentity: record.expectedCheckoutIdentity
      })
    : undefined
  const resolveRemovedPushTarget = () =>
    resolveWorktreeRemovalMetadata(
      host.store,
      record.repoId,
      record.worktreeId,
      LOCAL_EXECUTION_HOST_ID
    )?.pushTarget
  return {
    run: async (stopSignal) => {
      // A reviewed checkout Git already deleted leaves only bookkeeping, which deletes no files.
      const checkoutGone = (await expectation?.resumeCheckout(record.worktreePath)) === 'gone'
      const removedPushTarget = resolveRemovedPushTarget()
      const result = await finishInterruptedLocalWorktreeRemoval({
        record,
        store: host.store,
        stopSignal,
        expectation: checkoutGone ? undefined : expectation,
        goneCheckout: checkoutGone ? expectation : undefined,
        removedPushTarget,
        acquireWatcherRemoval: (path) => {
          // Take the gate in the same tick as the loading fence so no spawn can enter between them.
          releaseStartupRemovalFence(record.worktreeId)
          return host.acquireWatcherRemoval(path)
        },
        closeWatchers: host.closeWatchers,
        stopPtys: host.stopPtys,
        preserveBranchHead: (result, fallbackHead) =>
          host.preservedBranchCleanup.preserveHead(result, fallbackHead),
        // remember() clears the cleanup target when no branch was preserved.
        finishRemoval: async (result, _rememberBranch, fallbackHead) => {
          expectation?.check()
          host.preservedBranchCleanup.remember(
            record.worktreeId,
            undefined,
            result,
            fallbackHead,
            removedPushTarget
          )
          await host.purge(record)
        }
      })
      host.onRemoved(record)
      return result
    },
    publish: () => host.publish(record.repoId)
  }
}

/** Finish from current Git/disk evidence; native markerless roots permit only empty rmdir. */
async function finishInterruptedLocalWorktreeRemoval(
  args: InterruptedLocalWorktreeRemovalArgs
): Promise<RemoveWorktreeResult> {
  const { record, store } = args
  const repo = resolveLocalWorktreeRemovalRepo(store, record.repoId)
  if (!repo) {
    console.warn(`[worktrees] dropping removal of ${record.worktreePath}: its repo is gone`)
    return {}
  }
  const localOptions = getLocalProjectWorktreeGitOptions(store, repo)
  const finishArgs: RuntimeLocalWorktreeRemovalFinishArgs = {
    expectation: args.expectation,
    store,
    removedPushTarget: args.removedPushTarget,
    closeWatchers: args.closeWatchers,
    preserveBranchHead: args.preserveBranchHead,
    finishRemoval: args.finishRemoval,
    repo,
    localOptions,
    force: record.force,
    deleteBranch: record.deleteBranch,
    target: { id: record.worktreeId }
  }
  if (args.goneCheckout) {
    return finishGoneCheckoutBookkeeping(args, args.goneCheckout, finishArgs)
  }
  const worktrees = await listWorktreesStrict(repo.path, {
    ...localOptions,
    signal: args.stopSignal
  })
  throwIfSignalAborted(args.stopSignal)
  const registered = worktrees.some((worktree) =>
    areWorktreePathsEqual(worktree.path, record.worktreePath)
  )
  let deletable = registered
    ? findRegisteredDeletableWorktree(
        repo.path,
        record.worktreePath,
        worktrees,
        CLIENT_REMOVAL_HOME
      )
    : undefined
  if (registered && !deletable) {
    throw new Error(
      `Worktree registration changed during deletion: ${record.worktreePath}. Retry deletion.`
    )
  }
  if (deletable && !isRecordedCheckout(deletable, record)) {
    throw differentCheckoutAtPathError(record.worktreePath)
  }
  args.expectation?.check()
  if (args.expectation && !deletable) {
    throw new Error('The reviewed Git workspace is no longer registered; files were left in place.')
  }
  const native = usesNativeWindowsRemoval(record.worktreePath, localOptions)
  const checkNotReplaced = () => assertCheckoutNotReplaced(record, localOptions)
  const markerOpts = { expectedMarker: record.gitdir }
  // Branch and head match a checkout moved and recreated at this path; only its marker tells them apart.
  if (deletable || native) {
    await checkNotReplaced()
  }
  const removalOptions = {
    ...localOptions,
    ...markerOpts,
    deleteBranch: false,
    knownRemovedWorktree: {
      branch: record.branch ? `refs/heads/${record.branch}` : '',
      head: record.head
    },
    checkoutDeleteSignal: args.stopSignal,
    beforeCheckoutDelete: checkNotReplaced
  }
  if (
    !native &&
    deletable &&
    (await waitForPromiseWithSignal(
      isCheckoutMissingGitLink(deletable.path, localOptions),
      args.stopSignal
    ))
  ) {
    if (args.expectation) {
      throw new Error(
        'The reviewed Git workspace checkout is incomplete; files were left in place.'
      )
    }
    throwIfSignalAborted(args.stopSignal)
    // If Git deleted .git first, it cannot remove/validate the checkout; prune registration only and keep all files for the checks below.
    await removeStaleLocalWorktreeRegistration({
      canonicalWorktreePath: deletable.path,
      repoPath: repo.path,
      localWorktreeGitOptions: localOptions,
      registeredWorktree: deletable,
      deleteBranch: false
    })
    deletable = undefined
  }
  // Check before teardown so refused folders retain terminals/watchers.
  const rootKey = recordedRootKey(record)
  const leftover =
    !native &&
    !deletable &&
    (await assertUnregisteredLeftoverRemovable(repo.path, record.worktreePath, worktrees, rootKey))
  // An empty folder has nothing for force to override; a marked orphan still needs it.
  if (leftover === 'orphan' && !record.force) {
    throw new Error(ORPHANED_WORKTREE_DIRECTORY_MESSAGE)
  }
  if (leftover === 'orphan') {
    await assertLeftoverIsRecordedCheckout(record, localOptions)
  }
  if (native) {
    await authorizeWindowsCheckout(
      repo.path,
      record.worktreePath,
      record.force,
      removalOptions,
      true
    )
  }
  throwIfSignalAborted(args.stopSignal)
  const gate = await args.acquireWatcherRemoval(record.worktreePath)
  try {
    throwIfSignalAborted(args.stopSignal)
    await args.stopPtys?.()
    throwIfSignalAborted(args.stopSignal)
    // Teardown awaited: the folder may have been swapped for another checkout since the first check.
    if (deletable || native) {
      await checkNotReplaced()
    }
  } catch (error) {
    await gate.finish(false)
    throw error
  }
  if (deletable) {
    return finishRuntimeLocalWorktreeRemoval(
      finishArgs,
      deletable,
      gate,
      args.stopSignal,
      checkNotReplaced,
      markerOpts
    )
  }
  let result: RemoveWorktreeResult
  let removed = false
  try {
    if (native) {
      await removeWorktree(repo.path, record.worktreePath, record.force, removalOptions)
    }
    const branch =
      record.deleteBranch && record.branch ? { name: record.branch, head: record.head } : null
    if (native) {
      await assertUnregisteredCheckoutGone(record.worktreePath)
      result = await deleteBranchOfUnregisteredWorktree(
        repo.path,
        record.worktreePath,
        branch,
        localOptions
      )
    } else {
      // Teardown awaited: re-read Git so a checkout registered at or inside the folder since survives.
      const still =
        leftover &&
        (await isLeftoverStillRemovable(repo.path, record, localOptions, args.stopSignal))
      // A folder that changed kind since the first check (a marker or files appeared) is not the one checked.
      if (still && still !== leftover) {
        throw differentCheckoutAtPathError(record.worktreePath)
      }
      if (still === 'orphan') {
        await removeLocalWorktreePath(record.worktreePath, localOptions, args.stopSignal, {
          markerLast: true,
          requireMarker: true,
          ...markerOpts
        })
      } else if (still === 'empty') {
        await removeEmptyLeftoverDirectory(record.worktreePath)
      }
      result = await finishUnregisteredWorktreeRemoval(
        repo.path,
        record.worktreePath,
        branch,
        // Recheck after teardown awaits in case a folder appeared meanwhile.
        () => assertUnregisteredCheckoutGone(record.worktreePath),
        localOptions
      )
    }
    removed = true
  } finally {
    await gate.finish(removed)
  }
  await cleanupRemovedWorktreePushTarget(finishArgs)
  // Awaited like the registered branch: the removal may only be reported
  // after the purge — and the Codex pretrust deletion inside it — landed.
  await args.finishRemoval(result, true, record.head)
  return result
}
