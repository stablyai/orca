import type { Repo } from '../../../../shared/repo-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import type { GitPushTarget } from '../../../../shared/worktree/types'
import { assertWorktreeUnlockedForRemoval } from '../../../../shared/worktree/removal'
import type { LocalProjectWorktreeGitOptions } from '../../../project-runtime-git-options'
import {
  assertWorktreeCleanForRemoval,
  listWorktreesStrict as listGitWorktreesStrict,
  removeWorktree
} from '../../../git/worktree'
import { gitExecFileAsync } from '../../../git/runner'
import { getWorktreeSharedLinkPaths } from '../../../git/worktree-shared-directories'
import {
  getLocalWorktreePathAccess,
  removeLocalWorktreePath,
  toLocalWorktreeRuntimePath
} from '../../../local-worktree-filesystem'
import { recoverLocalWindowsWorktreeRemoval } from '../../../local-worktree-removal-recovery'
import { withWorktreeRemoveStageSpan } from '../../../observability/instrumentation'
import {
  canSafelyRemoveOrphanedWorktreeDirectory,
  findRegisteredDeletableWorktree
} from '../../../worktree-removal-safety'
import {
  cleanupUnusedWorktreePushTargetRemote,
  notifyWorktreesChanged
} from '../../worktree-remote'
import {
  findExistingWorktreeSymlinkPaths,
  removeWorktreeLinkedPaths
} from '../../worktree-symlinks'
import { invalidateAuthorizedRootsCache } from '../../registered-worktree-roots-cache'
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
  const { mainWindow, store, runtime } = context
  const refreshedWorktrees = hasLocalWorktreeGitOptions
    ? await listGitWorktreesStrict(repo.path, localWorktreeGitOptions)
    : await listGitWorktreesStrict(repo.path)
  const refreshedRegisteredWorktree = findRegisteredDeletableWorktree(
    repo.path,
    canonicalWorktreePath,
    refreshedWorktrees
  )
  if (!refreshedRegisteredWorktree) {
    throw new Error(
      `Worktree registration changed during deletion: ${canonicalWorktreePath}. Retry deletion.`
    )
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

  let removalResult: RemoveWorktreeResult | undefined
  const removalGate = await withWorktreeRemoveStageSpan('watcher_gate', 'local', async () =>
    runtime.acquireFileWatcherRemoval(canonicalWorktreePath)
  )
  let removalCompleted = false
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

    try {
      const removeOptions = {
        ...(!deleteBranch ? { deleteBranch } : {}),
        // Why: reuse the authoritative worktree list already computed here instead of rescanning siblings on the hot delete path.
        knownRemovedWorktree: refreshedRegisteredWorktree,
        ...(hasLocalWorktreeGitOptions ? localWorktreeGitOptions : {})
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
        const access = getLocalWorktreePathAccess(localWorktreeGitOptions)
        if (
          await canSafelyRemoveOrphanedWorktreeDirectory(
            toLocalWorktreeRuntimePath(canonicalWorktreePath, localWorktreeGitOptions),
            toLocalWorktreeRuntimePath(repo.path, localWorktreeGitOptions),
            access.statPath,
            access.readPath
          )
        ) {
          await runtime.closeFileWatchersForRemoval(canonicalWorktreePath)
          await removeLocalWorktreePath(canonicalWorktreePath, localWorktreeGitOptions).catch(
            () => {}
          )
        } else {
          console.warn(
            `[worktrees] Refusing recursive cleanup for unproven worktree directory: ${canonicalWorktreePath}`
          )
        }
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
        notifyWorktreesChanged(mainWindow, repoId)
        removalCompleted = true
        return {}
      } else {
        throw new Error(
          formatWorktreeRemovalError(error, canonicalWorktreePath, args.force ?? false)
        )
      }
    }
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

  notifyWorktreesChanged(mainWindow, repoId)
  return removalResult ?? {}
}
