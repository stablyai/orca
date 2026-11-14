import type { Repo } from '../../../../shared/repo-types'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import { killAllProcessesForWorktree } from '../../../runtime/workspaces/removal/worktree-teardown'
import { withWorktreeRemoveStageSpan } from '../../../observability/instrumentation'
import { preservedBranchCleanupScopeKey } from '../../../../shared/git/branches/preserved-branch-cleanup'
import { notifyWorktreesChanged } from '../../worktree-remote'
import { clearProviderPtyState } from '../../pty/provider/state-cleanup'
import { getLocalPtyProvider } from '../../pty/provider/registry'
import type { RemoveWorktreeArgs } from '../ipc-context-schemas'
import type { WorktreeIpcContext } from '../worktree-ipc-context'
import { getFolderWorkspaceRootId } from '../folder-workspace-model'
import { preservedBranchCleanupByScope } from './preserved-branch-cleanup'
import { removeWorktreeMetadataAndTransientState } from './worktree-removal-ownership'
import { teardownStops } from '../../../runtime/workspaces/removal/owned-session-teardown-policy'
import {
  gateFolderWorkspaceRemovalOnArchiveHook,
  removeFolderWorkspaceRunnerFiles
} from '../../../workspaces/removal/folder-workspace-archive-hook'
import { readWorktreeMetaForRepo } from '../../../persistence/host-qualified-worktree-meta'
import { getLocalProjectWorktreeGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'

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
  // Archive failure must refuse before watcher, PTY or metadata teardown (#19334).
  const archiveHookOverride = await gateFolderWorkspaceRemovalOnArchiveHook({
    repo,
    worktreeId: args.worktreeId,
    displayName:
      (
        readWorktreeMetaForRepo(store, args.worktreeId, repo) ??
        store.getWorktreeMeta(args.worktreeId)
      )?.displayName ?? repo.displayName,
    runArchive: !args.skipArchive,
    allowFailure: args.allowFailedArchiveHook === true,
    runtimeTarget: () => getLocalProjectWorktreeGitOptions(store, repo)
  })
  const ownerHost = parseExecutionHostId(removalHostId)
  const gate = await runtime.acquireFileWatcherRemoval(
    repo.path,
    ownerHost?.kind === 'ssh' ? ownerHost.targetId : undefined
  )
  try {
    // Shared-root folder removal has no Git step to close shells; stop them before dropping metadata.
    await withWorktreeRemoveStageSpan('pty_sweep', 'folder', async () => {
      // Fence by resolved repo ownership; same-ID metadata can describe another host's workspace.
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
        // PTY inventories cannot see structured sessions; close them before forgetting the workspace.
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
    removeFolderWorkspaceRunnerFiles(repo, args.worktreeId)
    notifyWorktreesChanged(mainWindow, repoId)
    return archiveHookOverride ? { archiveHookOverride } : {}
  } finally {
    await gate.finish(false)
  }
}
