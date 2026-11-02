import type { Repo } from '../../../../shared/repo-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import { assertRemovalHostMatchesRepoRow } from '../repo-host-ownership'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { assertWorktreeUnlockedForRemoval } from '../../../../shared/worktree/removal'
import { isWindowsAbsolutePathLike } from '../../../../shared/cross-platform-path'
import { getLocalProjectWorktreeGitOptions } from '../../../project-runtime-git-options'
import { listWorktreesStrict as listGitWorktreesStrict } from '../../../git/worktree'
import {
  SshHostNotServedError,
  SSH_WORKTREE_REMOVAL_NOT_SERVED_MESSAGE
} from '../../../providers/ssh-host-not-served-error'
import { resolveWorktreeRemovalMetadata } from '../../../worktree-removal-repo-owner'
import {
  authorizeUnregisteredWindowsRemoval,
  nativeWindowsMarkerMissing,
  usesNativeWindowsRemoval
} from '../../../git/windows-worktree-removal'
import { isPrunableGitFileWorktree } from '../../../worktree-prunable-git-file'
import { findRegisteredDeletableWorktree } from '../../../worktree-removal-safety'
import { assertNestedWorktreeRemovalApproval } from '../../../nested-worktree-removal-plan'
import { removeStaleLocalWorktreeRegistration } from '../../../local-worktree-removal-recovery'
import { resolveWorktreeRemovalHomeForHost } from '../../../worktree-removal-execution-host-route'
import { getEffectiveHooks, runHook } from '../../../hooks'
import type { ArchiveHookOverride } from '../../../../shared/worktree/archive-hook-removal-gate'
import { gateWorktreeRemovalOnArchiveHook } from '../../../worktree-archive-hook-gate'
import { withWorktreeRemoveStageSpan } from '../../../observability/instrumentation'
import {
  cleanupUnusedWorktreePushTargetRemote,
  notifyWorktreesChanged
} from '../../worktree-remote'
import { invalidateAuthorizedRootsCache } from '../../registered-worktree-roots-cache'
import { formatWorktreeRemovalError } from '../../worktree-logic'
import type { RemoveWorktreeArgs } from '../ipc-context-schemas'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import { isAlreadyRemovedWorktreePath } from './worktree-removal-filesystem'
import { rememberPreservedBranchCleanupTarget } from './preserved-branch-cleanup'
import { removeWorktreeMetadataAndTransientState } from './worktree-removal-ownership'
import { removeFolderWorkspace } from './remove-folder-workspace'
import { removeUnregisteredWorktree } from './remove-unregistered-worktree'
import { removeRegisteredLocalWorktree } from './remove-registered-local-worktree'
import { retryFailedLocalWorktreeRemoval } from './retry-failed-local-worktree-removal'
import { retryFailedRemovalUnlessRegistered } from '../../../worktree-removal-leftover'

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
  assertRemovalHostMatchesRepoRow(repo, repoId, removalHostId)
  if (repo.connectionId) {
    throw new SshHostNotServedError(repo.connectionId, SSH_WORKTREE_REMOVAL_NOT_SERVED_MESSAGE)
  }
  const localWorktreeGitOptions = getLocalProjectWorktreeGitOptions(store, repo)
  const hasLocalWorktreeGitOptions = Object.keys(localWorktreeGitOptions).length > 0
  const registeredWorktrees = hasLocalWorktreeGitOptions
    ? await listGitWorktreesStrict(repo.path, localWorktreeGitOptions)
    : await listGitWorktreesStrict(repo.path)
  const removedMeta = resolveWorktreeRemovalMetadata(store, repoId, args.worktreeId, removalHostId)
  const removedPushTarget = removedMeta?.pushTarget
  const registeredWorktree = findRegisteredDeletableWorktree(
    repo.path,
    worktreePath,
    registeredWorktrees,
    resolveWorktreeRemovalHomeForHost(removalHostId)
  )
  if (args.expectedCheckout) {
    assertNestedWorktreeRemovalApproval(registeredWorktree ? [registeredWorktree] : [], [
      args.expectedCheckout
    ])
  }
  await authorizeUnregisteredWindowsRemoval(
    !!registeredWorktree,
    repo.path,
    worktreePath,
    args.force ?? false,
    localWorktreeGitOptions
  )
  if (
    await retryFailedRemovalUnlessRegistered(
      args.worktreeId,
      worktreePath,
      registeredWorktrees,
      localWorktreeGitOptions,
      () => retryFailedLocalWorktreeRemoval(context, args, removalHostId)
    )
  ) {
    return { removing: true }
  }
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
      localWorktreeGitOptions
    )
  }
  const canonicalWorktreePath = registeredWorktree.path

  const deleteBranch = removedMeta?.preserveBranchOnDelete !== true

  try {
    assertWorktreeUnlockedForRemoval(registeredWorktree)
  } catch (error) {
    throw new Error(formatWorktreeRemovalError(error, canonicalWorktreePath, args.force ?? false))
  }

  // Stale registrations have no checkout to archive; missing cwd must not block metadata cleanup.
  if (
    !usesNativeWindowsRemoval(canonicalWorktreePath, localWorktreeGitOptions) &&
    ((await isPrunableGitFileWorktree(registeredWorktree, localWorktreeGitOptions)) ||
      (args.force === true &&
        process.platform === 'win32' &&
        (isWindowsAbsolutePathLike(canonicalWorktreePath) || !!localWorktreeGitOptions.wslDistro) &&
        removedMeta &&
        (await isAlreadyRemovedWorktreePath(canonicalWorktreePath, localWorktreeGitOptions))))
  ) {
    const removalResult = await removeStaleLocalWorktreeRegistration({
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
      { store, runtime },
      args.worktreeId,
      removalHostId,
      args.snapshotPruneBatchId
    )
    invalidateAuthorizedRootsCache()
    notifyWorktreesChanged(mainWindow, repoId)
    return removalResult ?? {}
  }

  const hooks = getEffectiveHooks(repo)

  const archiveScript = hooks?.scripts.archive

  // Archive failure must refuse before PTY teardown or checkout deletion (#19334).
  let archiveHookOverride: ArchiveHookOverride | undefined
  if (
    archiveScript &&
    !args.skipArchive &&
    !(await nativeWindowsMarkerMissing(canonicalWorktreePath, localWorktreeGitOptions))
  ) {
    await withWorktreeRemoveStageSpan('archive_hook', 'local', async () => {
      const result = await runHook(
        'archive',
        canonicalWorktreePath,
        repo,
        undefined,
        localWorktreeGitOptions
      )
      archiveHookOverride = gateWorktreeRemovalOnArchiveHook({
        worktreePath: canonicalWorktreePath,
        result,
        allowFailure: args.allowFailedArchiveHook === true
      })
    })
  }

  const result = await removeRegisteredLocalWorktree(
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
  return archiveHookOverride ? { ...result, archiveHookOverride } : result
}
