import type { Repo } from '../../../../shared/repo-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import type { GitPushTarget, GitWorktreeInfo } from '../../../../shared/worktree/types'
import type { SshGitProvider } from '../../../providers/ssh-git-provider'
import { deleteRemoteWorktreeHistory } from '../../../remote-worktree-history-cleanup'
import { withWorktreeRemoveStageSpan } from '../../../observability/instrumentation'
import { getSshPtyProvider } from '../../pty'
import {
  cleanupUnusedWorktreePushTargetRemoteSsh,
  notifyWorktreesChanged
} from '../../worktree-remote'
import type { RemoveWorktreeArgs } from '../ipc-context-schemas'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import {
  preserveBranchHeadFallback,
  rememberPreservedBranchCleanupTarget
} from './preserved-branch-cleanup'
import {
  removeWorktreeMetadataAndTransientState,
  stopPtysForDestructiveWorktreeRemoval
} from './worktree-removal-ownership'

export async function removeRegisteredRemoteWorktree(
  context: WorktreeIpcContext,
  args: RemoveWorktreeArgs,
  repo: Repo,
  repoId: string,
  canonicalWorktreePath: string,
  removalHostId: ExecutionHostId,
  registeredWorktree: GitWorktreeInfo,
  removedPushTarget: GitPushTarget | undefined,
  provider: SshGitProvider,
  deleteBranch: boolean
): Promise<RemoveWorktreeResult> {
  const { mainWindow, store, runtime } = context
  const remoteConnectionId = repo.connectionId!
  // Why: SSH deletion mirrors the local flow — hooks run while the directory is intact, then the clean check guards removal.
  if (!args.force) {
    const { clean, stdout } = await provider!.worktreeIsClean(canonicalWorktreePath)
    if (!clean) {
      const error = new Error('Worktree has uncommitted or untracked changes.')
      ;(error as Error & { stdout?: string }).stdout = stdout
      throw error
    }
  }

  const remoteRemoveOptions = !deleteBranch ? { deleteBranch } : {}
  const removalGate = await withWorktreeRemoveStageSpan('watcher_gate', 'remote', async () =>
    runtime.acquireFileWatcherRemoval(canonicalWorktreePath, remoteConnectionId)
  )
  let rawRemovalResult: RemoveWorktreeResult | undefined
  let removalCompleted = false
  try {
    await withWorktreeRemoveStageSpan('pty_sweep', 'remote', async () => {
      await stopPtysForDestructiveWorktreeRemoval(runtime, args.worktreeId, {
        connectionId: remoteConnectionId,
        allowUnverifiedStop: args.allowUnverifiedPtyStop
      })
    })
    rawRemovalResult = await withWorktreeRemoveStageSpan('git_remove', 'remote', async () =>
      Object.keys(remoteRemoveOptions).length > 0
        ? provider!.removeWorktree(canonicalWorktreePath, args.force, remoteRemoveOptions)
        : provider!.removeWorktree(canonicalWorktreePath, args.force)
    )
    removalCompleted = true
  } finally {
    await removalGate.finish(removalCompleted)
  }
  const removalResult = preserveBranchHeadFallback(rawRemovalResult, registeredWorktree.head)
  await cleanupUnusedWorktreePushTargetRemoteSsh(
    provider!,
    repo.path,
    args.worktreeId,
    removedPushTarget,
    store
  )
  await deleteRemoteWorktreeHistory(getSshPtyProvider(remoteConnectionId), args.worktreeId)
  rememberPreservedBranchCleanupTarget(
    args.worktreeId,
    removalHostId,
    removalResult,
    registeredWorktree.head,
    removedPushTarget
  )
  runtime.clearOptimisticReconcileToken(args.worktreeId)
  await withWorktreeRemoveStageSpan('metadata_purge', 'remote', async () => {
    removeWorktreeMetadataAndTransientState(
      store,
      args.worktreeId,
      removalHostId,
      args.snapshotPruneBatchId
    )
  })
  notifyWorktreesChanged(mainWindow, repoId)
  return removalResult ?? {}
}
