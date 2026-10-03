import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { RemoveWorktreeResult } from '../../shared/worktree/create-types'
import type { GitWorktreeInfo } from '../../shared/worktree/types'
import { assertWorktreeUnlockedForRemoval } from '../../shared/worktree/removal'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { Store } from '../persistence'
import {
  releaseStartupRemovalFence,
  type BackgroundWorktreeRemovalJob
} from '../worktree-background-removal'
import { resolveWorktreeRemovalMetadata } from '../worktree-removal-repo-owner'
import type { RuntimePreservedBranchCleanup } from './runtime-preserved-branch-cleanup'
import { listWorktreesStrict } from '../git/worktree'
import { finishUnregisteredWorktreeRemoval } from '../git/worktree-removal'
import { getErrorCode, normalizeLocalBranchRef } from '../git/worktree-operation-options'
import { restoreMissingWorktreeGitFile } from '../git/worktree-git-file-restore'
import { areWorktreePathsEqual } from '../git/worktree-path-comparison'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import { findRegisteredDeletableWorktree } from '../worktree-removal-safety'
import {
  assertUnregisteredRemovalLeftover,
  differentCheckoutAtPathError,
  isUnregisteredRemovalLeftover
} from '../worktree-removal-leftover'
import { CLIENT_REMOVAL_HOME } from '../worktree-removal-home-guard'
import type { WorktreeRemovalRecord } from '../worktree-removal-records'
import {
  cleanupRemovedWorktreePushTarget,
  finishRuntimeLocalWorktreeRemoval,
  type RuntimeLocalWorktreeRemovalFinishArgs
} from './runtime-registered-local-worktree-removal'

type InterruptedWorktreeRemovalHost = {
  store: Store
  acquireWatcherRemoval: (path: string) => Promise<{ finish: (removed: boolean) => Promise<void> }>
  closeWatchers: (path: string) => Promise<void>
  preservedBranchCleanup: Pick<RuntimePreservedBranchCleanup, 'preserveHead' | 'remember'>
  /** A retry's teardown: terminals may have opened in the leftover since the failed delete. */
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
  return {
    run: async (stopSignal) => {
      const removedPushTarget = resolveWorktreeRemovalMetadata(
        host.store,
        record.repoId,
        record.worktreeId,
        LOCAL_EXECUTION_HOST_ID
      )?.pushTarget
      const result = await finishInterruptedLocalWorktreeRemoval({
        record,
        store: host.store,
        stopSignal,
        removedPushTarget,
        acquireWatcherRemoval: (path) => {
          // Why same tick: the gate takes over the loading fence's path with no gap for a spawn.
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
    publish: () => host.publish(record.repoId)
  }
}

type InterruptedLocalWorktreeRemovalArgs = Pick<
  RuntimeLocalWorktreeRemovalFinishArgs,
  'removedPushTarget' | 'closeWatchers' | 'preserveBranchHead' | 'finishRemoval'
> & {
  store: Store
  record: WorktreeRemovalRecord
  acquireWatcherRemoval: (path: string) => Promise<{ finish: (removed: boolean) => Promise<void> }>
  stopPtys?: () => Promise<void>
  stopSignal: AbortSignal
}

/**
 * Finishes a removal a quit or crash interrupted. What is left comes from Git and disk, not the
 * record, so a delete Git already finished (fully or partly) completes the same way.
 */
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
    // Why force: Git already deleted part of the checkout, which reads as local changes.
    force: true,
    deleteBranch: record.deleteBranch,
    target: { id: record.worktreeId }
  }
  const worktrees = await listWorktreesStrict(repo.path, localOptions)
  const registered = worktrees.some((worktree) =>
    areWorktreePathsEqual(worktree.path, record.worktreePath)
  )
  const deletable = registered
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
  const gitLink = await readCheckoutGitLink(record.worktreePath)
  // Why: the finish forces, so a checkout created at this path since the quit must not be taken.
  // At an unregistered path, only a `.git` naming the admin entry Git removed is this checkout's
  // own leftover (Git drops the registration even when its delete fails partway).
  if (
    deletable
      ? !isRecordedCheckout(deletable, record)
      : !(await isUnregisteredRemovalLeftover(repo.path, record.worktreePath))
  ) {
    throw differentCheckoutAtPathError(record.worktreePath)
  }
  // Why: Git deletes `.git` wherever it falls in directory order (early on NTFS) and refuses to
  // remove a checkout left without it; restoring the link from Git's admin entry lets Git finish.
  let gitCanRemove = !!deletable
  if (deletable && gitLink === 'missing') {
    assertWorktreeUnlockedForRemoval(deletable)
    gitCanRemove = await restoreMissingWorktreeGitFile(repo.path, deletable.path, localOptions)
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
  if (deletable && gitCanRemove) {
    return finishRuntimeLocalWorktreeRemoval(finishArgs, deletable, gate, args.stopSignal)
  }
  // Unregistered, or no admin entry claims the checkout so Git cannot validate it: the leftover is
  // deleted in this process as a last resort, then pruned.
  let result: RemoveWorktreeResult
  let removed = false
  try {
    result = await finishUnregisteredWorktreeRemoval(
      repo.path,
      record.worktreePath,
      record.deleteBranch && record.branch ? { name: record.branch, head: record.head } : null,
      // Why only unregistered: a registered checkout here was just proven to be the recorded one.
      deletable
        ? async () => {}
        : () => assertUnregisteredRemovalLeftover(repo.path, record.worktreePath, localOptions),
      localOptions
    )
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

function isRecordedCheckout(worktree: GitWorktreeInfo, record: WorktreeRemovalRecord): boolean {
  return (
    normalizeLocalBranchRef(worktree.branch) === record.branch &&
    (!record.head || worktree.head === record.head)
  )
}

/** `missing`: the checkout directory is there without its `.git`; unreadable counts as present. */
async function readCheckoutGitLink(
  worktreePath: string
): Promise<'no-checkout' | 'missing' | 'present'> {
  try {
    await lstat(worktreePath)
  } catch {
    return 'no-checkout'
  }
  try {
    await lstat(join(worktreePath, '.git'))
    return 'present'
  } catch (error) {
    return getErrorCode(error) === 'ENOENT' ? 'missing' : 'present'
  }
}
