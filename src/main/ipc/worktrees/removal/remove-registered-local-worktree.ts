import { finishLocalWorktreeRemoval } from './finish-local-worktree-removal'
import { assertRegisteredLocalWorktreePreflight } from './registered-local-worktree-preflight'
import { runRequiredWorktreeRemoveHook } from '../../../worktree-remove-hook-gate'
import type { Repo } from '../../../../shared/repo-types'
import { nativeWindowsMarkerMissing } from '../../../git/windows-worktree-removal'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import type { GitPushTarget } from '../../../../shared/worktree/types'
import { assertWorktreeUnlockedForRemoval } from '../../../../shared/worktree/removal'
import type { LocalProjectWorktreeGitOptions } from '../../../project-runtime-git-options'
import { listWorktreesStrict as listGitWorktreesStrict } from '../../../git/worktree'
import { getWorktreeSharedLinkPaths } from '../../../git/worktree-shared-directories'
import { withWorktreeRemoveStageSpan } from '../../../observability/instrumentation'
import { assertNestedWorktreeRemovalApproval } from '../../../nested-worktree-removal-plan'
import { findRegisteredDeletableWorktree } from '../../../worktree-removal-safety'
import { CLIENT_REMOVAL_HOME } from '../../../worktree-removal-home-guard'
import { cleanupUnusedWorktreePushTargetRemote } from '../../worktree-remote'
import {
  findExistingWorktreeSymlinkPaths,
  removeWorktreeLinkedPaths
} from '../../worktree-symlinks'
import { formatWorktreeRemovalError } from '../../worktree-logic'
import type { RemoveWorktreeArgs } from '../ipc-context-schemas'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import { stopPtysForDestructiveWorktreeRemoval } from './worktree-removal-ownership'
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
    // Archive hooks can race external Git locks; recheck before destructive teardown.
    assertWorktreeUnlockedForRemoval(refreshedRegisteredWorktree)
  } catch (error) {
    throw new Error(formatWorktreeRemovalError(error, canonicalWorktreePath, args.force ?? false))
  }

  // Repo shared-directory symlinks need the same ignore/unlink policy as user-configured shared paths.
  const linkedPaths = getWorktreeSharedLinkPaths(repo)
  const ignoredLinkedPaths = args.force
    ? []
    : await findExistingWorktreeSymlinkPaths(canonicalWorktreePath, linkedPaths)
  const markerMissing = await nativeWindowsMarkerMissing(
    canonicalWorktreePath,
    localWorktreeGitOptions
  )
  await assertRegisteredLocalWorktreePreflight(
    repo.path,
    canonicalWorktreePath,
    refreshedRegisteredWorktree,
    args.force ?? false,
    localWorktreeGitOptions,
    hasLocalWorktreeGitOptions,
    ignoredLinkedPaths,
    markerMissing
  )

  if (!markerMissing) {
    await runRequiredWorktreeRemoveHook(
      repo,
      canonicalWorktreePath,
      localWorktreeGitOptions,
      args.removeHookHash
    )
  }

  const removalGate = await withWorktreeRemoveStageSpan('watcher_gate', 'local', async () =>
    runtime.acquireFileWatcherRemoval(canonicalWorktreePath)
  )
  let accepted = false
  try {
    // Fence watcher/spawn installs through linked-path cleanup, Git removal and recursive fallback; PTYs must release handles first.
    await withWorktreeRemoveStageSpan('pty_sweep', 'local', async () => {
      await stopPtysForDestructiveWorktreeRemoval(runtime, args.worktreeId, {
        allowUnverifiedStop: args.allowUnverifiedPtyStop
      })
    })

    if (!markerMissing && linkedPaths.length > 0) {
      await removeWorktreeLinkedPaths(canonicalWorktreePath, linkedPaths)
    }
    accepted = true
  } finally {
    if (!accepted) {
      await removalGate.finish(false)
    }
  }

  const cleanupPushTarget = () =>
    cleanupUnusedWorktreePushTargetRemote(
      repo.path,
      args.worktreeId,
      removedPushTarget,
      context.store,
      localWorktreeGitOptions
    )
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
      checkoutDeleteSignal,
      cleanupPushTarget
    })
  if (!removesInBackground(canonicalWorktreePath, localWorktreeGitOptions)) {
    const result = await finish()
    runtime.publishWorktreeRemovalChange(repoId)
    return result
  }
  // After acceptance, deletion must survive request cancellation; other views observe the host's removing marker.
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
    publish: () => runtime.publishWorktreeRemovalChange(repoId),
    cleanupPushTargetRemote: cleanupPushTarget
  })
  return { removing: true }
}
