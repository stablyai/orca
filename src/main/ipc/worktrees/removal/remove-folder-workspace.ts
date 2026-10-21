import type { Repo } from '../../../../shared/repo-types'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import { killAllProcessesForWorktree } from '../../../runtime/worktree-teardown'
import { withWorktreeRemoveStageSpan } from '../../../observability/instrumentation'
import { preservedBranchCleanupScopeKey } from '../../../../shared/preserved-branch-cleanup'
import { notifyWorktreesChanged } from '../../worktree-remote'
import { clearProviderPtyState } from '../../pty/provider/state-cleanup'
import { getLocalPtyProvider } from '../../pty/provider/registry'
import type { RemoveWorktreeArgs } from '../ipc-context-schemas'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import { getFolderWorkspaceRootId } from '../folder-workspace-model'
import { preservedBranchCleanupByScope } from './preserved-branch-cleanup'
import { removeWorktreeMetadataAndTransientState } from './worktree-removal-ownership'
import { teardownStops } from '../../../runtime/owned-session-teardown-policy'

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
      localProvider: getLocalPtyProvider(),
      onPtyStopped: clearProviderPtyState,
      // A structured session is on no PTY surface, so the sweeps above leave it attached to a
      // workspace this removal is about to forget. Closed best-effort, exactly like those PTYs.
      closeStructuredSessions: teardownStops('folder-removal', 'structured-chat'),
      ...(externalHost ? { includeProviderInventory: false, includeLocalRegistry: false } : {})
    }).catch((err) => {
      console.warn(`[worktree-teardown] failed for ${args.worktreeId}:`, err)
    })
  })
  await withWorktreeRemoveStageSpan('metadata_purge', 'folder', async () => {
    removeWorktreeMetadataAndTransientState(
      { store, runtime, entryPoint: 'folder-removal' },
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
