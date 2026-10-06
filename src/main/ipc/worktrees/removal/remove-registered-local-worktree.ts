import type { Repo } from '../../../../shared/repo-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import type { GitPushTarget, GitWorktreeInfo } from '../../../../shared/worktree/types'
import { assertWorktreeUnlockedForRemoval } from '../../../../shared/worktree/removal'
import type { LocalProjectWorktreeGitOptions } from '../../../project-runtime-git-options'
import {
  assertWorktreeCleanForRemoval,
  listWorktreesStrict as listGitWorktreesStrict,
  removeWorktree
} from '../../../git/worktree'
import { gitExecFileAsync } from '../../../git/runner'
import { getWorktreeSharedLinkPaths } from '../../../git/worktree-shared-directories'
import { cleanupLocalOrphanedWorktreeDirectory } from '../../../local-orphaned-worktree-cleanup'
import { recoverLocalWindowsWorktreeRemoval } from '../../../local-worktree-removal-recovery'
import { withWorktreeRemoveStageSpan } from '../../../observability/instrumentation'
import { assertNestedWorktreeRemovalApproval } from '../../../nested-worktree-removal-plan'
import { findRegisteredDeletableWorktree } from '../../../worktree-removal-safety'
import { CLIENT_REMOVAL_HOME } from '../../../worktree-removal-home-guard'
import { cleanupUnusedWorktreePushTargetRemote } from '../../worktree-remote'
import {
  findExistingWorktreeSymlinkPaths,
  removeWorktreeLinkedPaths
} from '../../worktree-symlinks'
import { invalidateAuthorizedRootsCache } from '../../registered-worktree-roots-cache'
import { runWorktreeChangeInvalidators } from '../../worktree-change-invalidators'
import {
  formatWorktreeRemovalError,
  isOrphanCompatiblePreflightError,
  isOrphanedWorktreeError
} from '../../worktree-logic'
import type { RemoveWorktreeArgs } from '../ipc-context-schemas'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import {
  preserveBranchHeadFallback,
  preservedBranchCleanupByScope,
  rememberPreservedBranchCleanupTarget
} from './preserved-branch-cleanup'
import {
  removeWorktreeMetadataAndTransientState,
  stopPtysForDestructiveWorktreeRemoval
} from './worktree-removal-ownership'
import { preservedBranchCleanupScopeKey } from '../../../../shared/preserved-branch-cleanup'
import {
  removesInBackground,
  startBackgroundWorktreeRemoval
} from '../../../worktree-background-removal'

export async function removeRegisteredLocalWorktree(
  context: WorktreeIpcContext,
  args: RemoveWorktreeArgs,
  repo: Repo,
  repoId: string,
  canonicalWorktreePath: string,
  removalHostId: ExecutionHostId,
  removedPushTarget: GitPushTarget | undefined,
  localWorktreeGitOptions: LocalProjectWorktreeGitOptions,
  hasLocalWorktreeGitOptions: boolean,
  deleteBranch: boolean
): Promise<RemoveWorktreeResult> {
  const { runtime } = context
  const refreshedWorktrees = hasLocalWorktreeGitOptions
    ? await listGitWorktreesStrict(repo.path, localWorktreeGitOptions)
    : await listGitWorktreesStrict(repo.path)
  const refreshedRegisteredWorktree = findRegisteredDeletableWorktree(
    repo.path,
    canonicalWorktreePath,
    refreshedWorktrees,
    CLIENT_REMOVAL_HOME
  )
  if (!refreshedRegisteredWorktree) {
    throw new Error(
      `Worktree registration changed during deletion: ${canonicalWorktreePath}. Retry deletion.`
    )
  }
  if (args.expectedCheckout) {
    assertNestedWorktreeRemovalApproval([refreshedRegisteredWorktree], [args.expectedCheckout])
  }
  try {
    // Why: an archive hook can race another Git client that locks the row; recheck before linked-path/watcher/terminal teardown.
    assertWorktreeUnlockedForRemoval(refreshedRegisteredWorktree)
  } catch (error) {
    throw new Error(formatWorktreeRemovalError(error, canonicalWorktreePath, args.force ?? false))
  }

  // Why: `orca.yaml` shared directories are symlinked in too, and a
  // directory-only ignore rule leaves those links untracked, so removal must
  // tolerate and unlink them exactly like the per-user shared paths.
  const linkedPaths = getWorktreeSharedLinkPaths(repo)
  const ignoredLinkedPaths = args.force
    ? []
    : await findExistingWorktreeSymlinkPaths(canonicalWorktreePath, linkedPaths)
  try {
    await (hasLocalWorktreeGitOptions
      ? assertWorktreeCleanForRemoval(canonicalWorktreePath, args.force ?? false, {
          ...localWorktreeGitOptions,
          ...(ignoredLinkedPaths.length > 0 ? { ignoredUntrackedPaths: ignoredLinkedPaths } : {})
        })
      : ignoredLinkedPaths.length > 0
        ? assertWorktreeCleanForRemoval(canonicalWorktreePath, args.force ?? false, {
            ignoredUntrackedPaths: ignoredLinkedPaths
          })
        : assertWorktreeCleanForRemoval(canonicalWorktreePath, args.force ?? false))
  } catch (error) {
    if (!isOrphanCompatiblePreflightError(error)) {
      throw new Error(formatWorktreeRemovalError(error, canonicalWorktreePath, args.force ?? false))
    }
    // Why: Git can still classify this as an orphan after preflight; keep strict PTY teardown before any recursive fallback deletion.
  }

  const removalGate = await withWorktreeRemoveStageSpan('watcher_gate', 'local', async () =>
    runtime.acquireFileWatcherRemoval(canonicalWorktreePath)
  )
  let accepted = false
  try {
    // Why: hold the watcher/terminal gate through Git and any recursive fallback so no late spawn recreates a native handle.
    // Linked-path deletion is destructive too, so PTYs must release every handle before Windows or WSL filesystem cleanup starts.
    await withWorktreeRemoveStageSpan('pty_sweep', 'local', async () => {
      await stopPtysForDestructiveWorktreeRemoval(runtime, args.worktreeId, {
        allowUnverifiedStop: args.allowUnverifiedPtyStop
      })
    })

    // Why: preflight only ignored these paths, not mutated them; keep watcher installs fenced through Git removal.
    if (linkedPaths.length > 0) {
      await removeWorktreeLinkedPaths(canonicalWorktreePath, linkedPaths)
    }
    accepted = true
  } finally {
    if (!accepted) {
      await removalGate.finish(false)
    }
  }

  const finish = (checkoutDeleteSignal?: AbortSignal): Promise<RemoveWorktreeResult> =>
    finishLocalWorktreeRemoval({
      context,
      args,
      repo,
      repoId,
      canonicalWorktreePath,
      removalHostId,
      removedPushTarget,
      localWorktreeGitOptions,
      hasLocalWorktreeGitOptions,
      deleteBranch,
      refreshedRegisteredWorktree,
      removalGate,
      checkoutDeleteSignal
    })
  if (!removesInBackground(canonicalWorktreePath, localWorktreeGitOptions)) {
    const result = await finish()
    runtime.publishWorktreeRemovalChange(repoId)
    return result
  }
  // Why detached: every refusal above already ran, and Git's 20-35 s delete must finish even when the
  // request that asked for it goes away; other views read the host's `removing` marker meanwhile.
  void startBackgroundWorktreeRemoval({
    removal: {
      worktreeId: args.worktreeId,
      repoId,
      repoPath: repo.path,
      worktree: refreshedRegisteredWorktree,
      deleteBranch,
      force: args.force ?? false
    },
    run: async (stopSignal) => {
      const result = await finish(stopSignal)
      context.options?.onWorktreeLifecycle?.({
        kind: 'removed',
        worktreeId: args.worktreeId,
        path: canonicalWorktreePath
      })
      return result
    },
    publish: () => runtime.publishWorktreeRemovalChange(repoId)
  })
  return { removing: true }
}

async function finishLocalWorktreeRemoval({
  context,
  args,
  repo,
  repoId,
  canonicalWorktreePath,
  removalHostId,
  removedPushTarget,
  localWorktreeGitOptions,
  hasLocalWorktreeGitOptions,
  deleteBranch,
  refreshedRegisteredWorktree,
  removalGate,
  checkoutDeleteSignal
}: {
  context: WorktreeIpcContext
  args: RemoveWorktreeArgs
  repo: Repo
  repoId: string
  canonicalWorktreePath: string
  removalHostId: ExecutionHostId
  removedPushTarget: GitPushTarget | undefined
  localWorktreeGitOptions: LocalProjectWorktreeGitOptions
  hasLocalWorktreeGitOptions: boolean
  deleteBranch: boolean
  refreshedRegisteredWorktree: GitWorktreeInfo
  removalGate: { finish: (removed: boolean) => Promise<void> }
  checkoutDeleteSignal?: AbortSignal
}): Promise<RemoveWorktreeResult> {
  const { store, runtime } = context
  let removalResult: RemoveWorktreeResult | undefined
  let removalCompleted = false
  try {
    try {
      const removeOptions = {
        ...(!deleteBranch ? { deleteBranch } : {}),
        // Why: reuse the authoritative worktree list already computed here instead of rescanning siblings on the hot delete path.
        knownRemovedWorktree: refreshedRegisteredWorktree,
        ...(hasLocalWorktreeGitOptions ? localWorktreeGitOptions : {}),
        checkoutDeleteSignal
      }
      removalResult = preserveBranchHeadFallback(
        await withWorktreeRemoveStageSpan('git_remove', 'local', async () =>
          removeWorktree(repo.path, canonicalWorktreePath, args.force ?? false, removeOptions)
        ),
        refreshedRegisteredWorktree.head
      )
    } catch (error) {
      // Why: Git for Windows can deregister a clean worktree before its recursive filesystem deletion fails transiently.
      const recoveredRemovalResult = await recoverLocalWindowsWorktreeRemoval({
        error,
        force: args.force ?? false,
        canonicalWorktreePath,
        repoPath: repo.path,
        localWorktreeGitOptions,
        registeredWorktree: refreshedRegisteredWorktree,
        deleteBranch,
        closeWatcher: (worktreePath) => runtime.closeFileWatchersForRemoval(worktreePath)
      })
      if (recoveredRemovalResult) {
        removalResult = recoveredRemovalResult
        removalCompleted = true
      } else if (isOrphanedWorktreeError(error)) {
        // If git no longer tracks this worktree, clean up the directory and metadata
        console.warn(
          `[worktrees] Orphaned worktree detected at ${canonicalWorktreePath}, cleaning up`
        )
        await cleanupLocalOrphanedWorktreeDirectory(
          repo.path,
          canonicalWorktreePath,
          localWorktreeGitOptions,
          (path) => runtime.closeFileWatchersForRemoval(path)
        )
        // Why: remove failed so git still tracks it (.git/worktrees/<name>); prune or the stale entry keeps its branch locked.
        await gitExecFileAsync(['worktree', 'prune'], {
          cwd: repo.path,
          ...localWorktreeGitOptions
        }).catch(() => {})
        await cleanupUnusedWorktreePushTargetRemote(
          repo.path,
          args.worktreeId,
          removedPushTarget,
          store,
          localWorktreeGitOptions
        )
        runtime.clearOptimisticReconcileToken(args.worktreeId)
        removeWorktreeMetadataAndTransientState(
          store,
          args.worktreeId,
          removalHostId,
          args.snapshotPruneBatchId
        )
        preservedBranchCleanupByScope.delete(
          preservedBranchCleanupScopeKey({
            worktreeId: args.worktreeId,
            hostId: removalHostId
          })
        )
        invalidateAuthorizedRootsCache()
        removalCompleted = true
        return {}
      } else {
        throw new Error(
          formatWorktreeRemovalError(error, canonicalWorktreePath, args.force ?? false)
        )
      }
    }
    // Why: the worktree is unlisted from here on; a scan that began before the removal is overtaken.
    runWorktreeChangeInvalidators(repoId)
    removalCompleted = true
  } finally {
    await removalGate.finish(removalCompleted)
  }
  await cleanupUnusedWorktreePushTargetRemote(
    repo.path,
    args.worktreeId,
    removedPushTarget,
    store,
    localWorktreeGitOptions
  )
  rememberPreservedBranchCleanupTarget(
    args.worktreeId,
    removalHostId,
    removalResult,
    refreshedRegisteredWorktree.head,
    removedPushTarget
  )
  runtime.clearOptimisticReconcileToken(args.worktreeId)
  await withWorktreeRemoveStageSpan('metadata_purge', 'local', async () => {
    removeWorktreeMetadataAndTransientState(
      store,
      args.worktreeId,
      removalHostId,
      args.snapshotPruneBatchId
    )
  })
  await withWorktreeRemoveStageSpan('cache_invalidation', 'local', async () => {
    invalidateAuthorizedRootsCache()
  })
  return removalResult ?? {}
}
