import type { Repo } from '../../../../shared/repo-types'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import { deleteRemoteWorktreeHistory } from '../../../remote-worktree-history-cleanup'
import { killAllProcessesForWorktree } from '../../../runtime/worktree-teardown'
import { withWorktreeRemoveStageSpan } from '../../../observability/instrumentation'
import { preservedBranchCleanupScopeKey } from '../../../../shared/preserved-branch-cleanup'
import { notifyWorktreesChanged } from '../../worktree-remote'
import { clearProviderPtyState, getLocalPtyProvider, getSshPtyProvider } from '../../pty'
import type { RemoveWorktreeArgs } from '../ipc-context-schemas'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import { getFolderWorkspaceRootId } from '../folder-workspace-model'
import { preservedBranchCleanupByScope } from './preserved-branch-cleanup'
import { removeWorktreeMetadataAndTransientState } from './worktree-removal-ownership'

export async function removeFolderWorkspace(
  context: WorktreeIpcContext,
  args: RemoveWorktreeArgs,
  repo: Repo,
  repoId: string,
  removalHostId: ExecutionHostId
): Promise<RemoveWorktreeResult> {
  const { mainWindow, store, runtime } = context
  if (args.worktreeId === getFolderWorkspaceRootId(repo)) {
    throw new Error('Cannot delete the project root workspace. Remove the folder project instead.')
  }
  const ownerHost = parseExecutionHostId(removalHostId)
  const sshPtyProvider =
    ownerHost?.kind === 'ssh' ? getSshPtyProvider(ownerHost.targetId) : undefined
  // Why: folder workspaces share one root, so there's no Git remove step to close shells; sweep PTYs before dropping metadata.
  await withWorktreeRemoveStageSpan('pty_sweep', 'folder', async () => {
    // Folder projects can be SSH-backed, so fence the sweep to the owning host exactly
    // like the git paths — the local inventory must never reach a remote workspace's id.
    // The resolved repo is authoritative here: path-derived metadata is shared by
    // same-id host copies and can describe a different owner's workspace.
    const externalHost = ownerHost?.kind === 'ssh' || ownerHost?.kind === 'runtime'
    await killAllProcessesForWorktree(args.worktreeId, {
      runtime,
      resolvedWorktreeId: args.worktreeId,
      ...(ownerHost?.kind === 'ssh' ? { resolvedConnectionId: ownerHost.targetId } : {}),
      ...(ownerHost?.kind === 'runtime'
        ? { resolvedRuntimeEnvironmentId: ownerHost.environmentId }
        : {}),
      localProvider: sshPtyProvider ?? getLocalPtyProvider(),
      onPtyStopped: clearProviderPtyState,
      ...(externalHost
        ? {
            includeProviderInventory: ownerHost?.kind === 'ssh' && Boolean(sshPtyProvider),
            includeLocalRegistry: false
          }
        : {})
    }).catch((err) => {
      console.warn(`[worktree-teardown] failed for ${args.worktreeId}:`, err)
    })
  })
  await withWorktreeRemoveStageSpan('metadata_purge', 'folder', async () => {
    await deleteRemoteWorktreeHistory(sshPtyProvider, args.worktreeId)
    removeWorktreeMetadataAndTransientState(
      store,
      args.worktreeId,
      removalHostId,
      args.snapshotPruneBatchId
    )
  })
  preservedBranchCleanupByScope.delete(
    preservedBranchCleanupScopeKey({ worktreeId: args.worktreeId, hostId: removalHostId })
  )
  notifyWorktreesChanged(mainWindow, repoId)
  return {}
}
