import type { Repo } from '../../../../shared/repo-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { assertWorktreeUnlockedForRemoval } from '../../../../shared/worktree/removal'
import { isWindowsAbsolutePathLike } from '../../../../shared/cross-platform-path'
import { getLocalProjectWorktreeGitOptions } from '../../../project-runtime-git-options'
import { listWorktreesStrict as listGitWorktreesStrict } from '../../../git/worktree'
import { requireSshGitProvider } from '../../../providers/ssh-git-dispatch'
import { resolveWorktreeRemovalMetadata } from '../../../worktree-removal-repo-owner'
import { findRegisteredDeletableWorktree } from '../../../worktree-removal-safety'
import { removeStaleLocalWorktreeRegistrationAfterFilesystemRemoval } from '../../../local-worktree-removal-recovery'
import { runHook } from '../../../hooks'
import { withWorktreeRemoveStageSpan } from '../../../observability/instrumentation'
import {
  cleanupUnusedWorktreePushTargetRemote,
  notifyWorktreesChanged
} from '../../worktree-remote'
import { invalidateAuthorizedRootsCache } from '../../registered-worktree-roots-cache'
import { formatWorktreeRemovalError } from '../../worktree-logic'
import type { RemoveWorktreeArgs } from '../ipc-context-schemas'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import { getArchiveHooksForRemoval, runRemoteArchiveHook } from './worktree-archive-hook'
import { isAlreadyRemovedWorktreePath } from './worktree-removal-filesystem'
import { rememberPreservedBranchCleanupTarget } from './preserved-branch-cleanup'
import { removeWorktreeMetadataAndTransientState } from './worktree-removal-ownership'
import { removeFolderWorkspace } from './remove-folder-workspace'
import { removeUnregisteredWorktree } from './remove-unregistered-worktree'
import { removeRegisteredRemoteWorktree } from './remove-registered-remote-worktree'
import { removeRegisteredLocalWorktree } from './remove-registered-local-worktree'

export async function executeWorktreeRemoval(
  context: WorktreeIpcContext,
  args: RemoveWorktreeArgs,
  repo: Repo,
  repoId: string,
  worktreePath: string,
  removalHostId: ExecutionHostId
): Promise<RemoveWorktreeResult> {
  const { mainWindow, store, runtime } = context
  if (isFolderRepo(repo)) {
    return removeFolderWorkspace(context, args, repo, repoId, removalHostId)
  }
  const provider = repo.connectionId ? requireSshGitProvider(repo.connectionId) : null
  const localWorktreeGitOptions = repo.connectionId
    ? {}
    : getLocalProjectWorktreeGitOptions(store, repo)
  const hasLocalWorktreeGitOptions = Object.keys(localWorktreeGitOptions).length > 0
  const registeredWorktrees = repo.connectionId
    ? await provider!.listWorktrees(repo.path)
    : hasLocalWorktreeGitOptions
      ? await listGitWorktreesStrict(repo.path, localWorktreeGitOptions)
      : await listGitWorktreesStrict(repo.path)
  const removedMeta = resolveWorktreeRemovalMetadata(store, repoId, args.worktreeId, removalHostId)
  const removedPushTarget = removedMeta?.pushTarget
  const registeredWorktree = findRegisteredDeletableWorktree(
    repo.path,
    worktreePath,
    registeredWorktrees
  )
  if (!registeredWorktree) {
    return removeUnregisteredWorktree(
      context,
      args,
      repo,
      repoId,
      worktreePath,
      removalHostId,
      registeredWorktrees,
      removedMeta,
      removedPushTarget,
      localWorktreeGitOptions,
      provider
    )
  }
  const canonicalWorktreePath = registeredWorktree.path

  const deleteBranch = removedMeta?.preserveBranchOnDelete !== true

  try {
    assertWorktreeUnlockedForRemoval(registeredWorktree)
  } catch (error) {
    throw new Error(formatWorktreeRemovalError(error, canonicalWorktreePath, args.force ?? false))
  }

  if (
    !repo.connectionId &&
    args.force === true &&
    process.platform === 'win32' &&
    (isWindowsAbsolutePathLike(canonicalWorktreePath) || !!localWorktreeGitOptions.wslDistro) &&
    removedMeta &&
    (await isAlreadyRemovedWorktreePath(repo, canonicalWorktreePath, localWorktreeGitOptions))
  ) {
    const removalResult = await removeStaleLocalWorktreeRegistrationAfterFilesystemRemoval({
      canonicalWorktreePath,
      repoPath: repo.path,
      localWorktreeGitOptions,
      registeredWorktree,
      deleteBranch
    })
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
      registeredWorktree.head,
      removedPushTarget
    )
    runtime.clearOptimisticReconcileToken(args.worktreeId)
    removeWorktreeMetadataAndTransientState(
      store,
      args.worktreeId,
      removalHostId,
      args.snapshotPruneBatchId
    )
    invalidateAuthorizedRootsCache()
    notifyWorktreesChanged(mainWindow, repoId)
    return removalResult ?? {}
  }

  const hooks = await getArchiveHooksForRemoval(repo)

  const archiveScript = hooks?.scripts.archive

  if (archiveScript && !args.skipArchive) {
    // Why the branch on connectionId: this block is shared by both flows, so a hardcoded
    // 'remote' would file every local archive hook under the SSH breakdown.
    await withWorktreeRemoveStageSpan(
      'archive_hook',
      repo.connectionId ? 'remote' : 'local',
      async () => {
        const result = repo.connectionId
          ? await runRemoteArchiveHook(repo, canonicalWorktreePath, archiveScript)
          : await runHook(
              'archive',
              canonicalWorktreePath,
              repo,
              undefined,
              localWorktreeGitOptions
            )
        if (!result.success) {
          console.error(`[hooks] archive hook failed for ${canonicalWorktreePath}:`, result.output)
        }
      }
    )
  }

  const remoteConnectionId = repo.connectionId ?? undefined
  if (remoteConnectionId) {
    return removeRegisteredRemoteWorktree(
      context,
      args,
      repo,
      repoId,
      canonicalWorktreePath,
      removalHostId,
      registeredWorktree,
      removedPushTarget,
      provider!,
      deleteBranch
    )
  }
  return removeRegisteredLocalWorktree(
    context,
    args,
    repo,
    repoId,
    canonicalWorktreePath,
    removalHostId,
    removedPushTarget,
    localWorktreeGitOptions,
    hasLocalWorktreeGitOptions,
    deleteBranch
  )
}
