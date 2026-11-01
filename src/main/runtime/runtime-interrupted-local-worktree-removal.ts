import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { RuntimeStore } from './runtime-store-contract'
import {
  releaseStartupRemovalFence,
  type BackgroundWorktreeRemovalJob
} from '../worktree-background-removal'
import { resolveWorktreeRemovalMetadata } from '../worktree-removal-repo-owner'
import type { RuntimePreservedBranchCleanup } from './runtime-preserved-branch-cleanup'
import { listWorktreesStrict } from '../git/worktree'
import { cleanupUnusedWorktreePushTargetRemote } from '../ipc/worktree-remote'
import { authorizeWindowsCheckout, usesNativeWindowsRemoval } from '../git/windows-worktree-removal'
import {
  deleteBranchOfUnregisteredWorktree,
  finishUnregisteredWorktreeRemoval,
  removeWorktree
} from '../git/worktree-removal'
import { getErrorCode } from '../git/worktree-operation-options'
import { areWorktreePathsEqual } from '../git/worktree-path-comparison'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import { findRegisteredDeletableWorktree } from '../worktree-removal-safety'
import {
  assertUnregisteredCheckoutGone,
  isRecordedCheckout,
  differentCheckoutAtPathError
} from '../worktree-removal-leftover'
import { CLIENT_REMOVAL_HOME, getPathOps } from '../worktree-removal-home-guard'
import { removeStaleLocalWorktreeRegistration } from '../local-worktree-removal-recovery'
import {
  getLocalWorktreePathAccess,
  toLocalWorktreeRuntimePath,
  type LocalWorktreeFilesystemOptions
} from '../local-worktree-filesystem'
import type { WorktreeRemovalRecord } from '../worktree-removal-records'
import {
  cleanupRemovedWorktreePushTarget,
  finishRuntimeLocalWorktreeRemoval,
  type RuntimeLocalWorktreeRemovalFinishArgs
} from './runtime-registered-local-worktree-removal'

type InterruptedWorktreeRemovalHost = {
  store: RuntimeStore
  acquireWatcherRemoval: (path: string) => Promise<{ finish: (removed: boolean) => Promise<void> }>
  closeWatchers: (path: string) => Promise<void>
  preservedBranchCleanup: Pick<RuntimePreservedBranchCleanup, 'preserveHead' | 'remember'>
  /** A retry's teardown: terminals opened in the folder before the user removed it. */
  stopPtys?: () => Promise<void>
  /** Drops the worktree's host state (metadata, history, caches), as every removal path does. */
  purge: (record: WorktreeRemovalRecord) => void | Promise<void>
  onRemoved: (record: WorktreeRemovalRecord) => void
  publish: (repoId: string) => void
}

/** The background job that finishes one interrupted removal on this host. */
export function interruptedLocalWorktreeRemovalJob(
  record: WorktreeRemovalRecord,
  host: InterruptedWorktreeRemovalHost
): BackgroundWorktreeRemovalJob {
  const resolveRemovedPushTarget = () =>
    resolveWorktreeRemovalMetadata(
      host.store,
      record.repoId,
      record.worktreeId,
      LOCAL_EXECUTION_HOST_ID
    )?.pushTarget
  return {
    run: async (stopSignal) => {
      const removedPushTarget = resolveRemovedPushTarget()
      const result = await finishInterruptedLocalWorktreeRemoval({
        record,
        store: host.store,
        stopSignal,
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
    publish: () => host.publish(record.repoId),
    cleanupPushTargetRemote: async () => {
      const repo = host.store.getRepo(record.repoId)
      if (repo) {
        await cleanupUnusedWorktreePushTargetRemote(
          repo.path,
          record.worktreeId,
          resolveRemovedPushTarget(),
          host.store,
          getLocalProjectWorktreeGitOptions(host.store, repo)
        )
      }
    }
  }
}

type InterruptedLocalWorktreeRemovalArgs = Pick<
  RuntimeLocalWorktreeRemovalFinishArgs,
  'removedPushTarget' | 'closeWatchers' | 'preserveBranchHead' | 'finishRemoval'
> & {
  store: RuntimeStore
  record: WorktreeRemovalRecord
  acquireWatcherRemoval: (path: string) => Promise<{ finish: (removed: boolean) => Promise<void> }>
  stopPtys?: () => Promise<void>
  stopSignal: AbortSignal
}

/** Finish from current Git/disk evidence; native markerless roots permit only empty rmdir. */
async function finishInterruptedLocalWorktreeRemoval(
  args: InterruptedLocalWorktreeRemovalArgs
): Promise<RemoveWorktreeResult> {
  const { record, store } = args
  const repo = store.getRepo(record.repoId)
  if (!repo) {
    console.warn(`[worktrees] dropping removal of ${record.worktreePath}: its repo is gone`)
    return {}
  }
  const localOptions = getLocalProjectWorktreeGitOptions(store, repo)
  const finishArgs: RuntimeLocalWorktreeRemovalFinishArgs = {
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
  const worktrees = await listWorktreesStrict(repo.path, localOptions)
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
  const native = usesNativeWindowsRemoval(record.worktreePath, localOptions)
  const removalOptions = {
    ...localOptions,
    deleteBranch: false,
    knownRemovedWorktree: {
      branch: record.branch ? `refs/heads/${record.branch}` : '',
      head: record.head
    },
    checkoutDeleteSignal: args.stopSignal
  }
  if (!native && deletable && (await isCheckoutMissingGitLink(deletable.path, localOptions))) {
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
  if (!native && !deletable) {
    await assertUnregisteredCheckoutGone(record.worktreePath, worktrees)
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
  const gate = await args.acquireWatcherRemoval(record.worktreePath)
  if (args.stopPtys) {
    try {
      await args.stopPtys()
    } catch (error) {
      await gate.finish(false)
      throw error
    }
  }
  if (deletable) {
    return finishRuntimeLocalWorktreeRemoval(finishArgs, deletable, gate, args.stopSignal)
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

/** A checkout folder still on disk whose `.git` link is gone. */
async function isCheckoutMissingGitLink(
  checkoutPath: string,
  options: LocalWorktreeFilesystemOptions
): Promise<boolean> {
  const { statPath } = getLocalWorktreePathAccess(options)
  const stat = (path: string) => statPath(toLocalWorktreeRuntimePath(path, options))
  try {
    await stat(checkoutPath)
  } catch {
    // Git removes a registration whose folder is gone; other errors are Git's to report.
    return false
  }
  try {
    await stat(getPathOps(checkoutPath).join(checkoutPath, '.git'))
    return false
  } catch (error) {
    return getErrorCode(error) === 'ENOENT'
  }
}
