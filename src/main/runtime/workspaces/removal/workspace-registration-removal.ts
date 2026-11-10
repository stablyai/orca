import type { OrcaRuntimeWithRemoveManagedWorktree } from './workspace-removal'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { RuntimeWorktreeRemovalTarget } from '../catalog/runtime-worktree-selection'
import type { Repo } from '../../../../shared/repo-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { WorktreeTeardownRuntime } from './worktree-teardown'
import { splitWorktreeId, splitWorktreeIdForFilesystem } from '../../../../shared/worktree/id'
import { isRepoOnCatalogHost, parseExecutionHostId } from '../../../../shared/execution-host'
import type { RemoveWorktreeResult } from '../../../../shared/worktree/create-types'
import { readWorktreeMetaForRepo } from '../../../persistence/host-qualified-worktree-meta'
import { getEffectiveHooks } from '../../../workspace-hooks/hooks'
import { blockedWslDistroForPath } from '../../../wsl/filesystem/wsl-unc-access-gate'
import { getLocalProjectWorktreeGitOptions } from '../../../workspaces/execution-host/project-runtime-git-options'
import {
  gateFolderWorkspaceRemovalOnArchiveHook,
  removeFolderWorkspaceRunnerFiles
} from '../../../workspaces/removal/folder-workspace-archive-hook'
import { invalidateAuthorizedRootsCache } from '../../../ipc/worktrees/removal/registered-worktree-roots-cache'
import { isFolderRepo } from '../../../../shared/repo-kind'
import { getRuntimeFolderWorkspaceRootId } from '../catalog/runtime-folder-workspace'
import { killAllProcessesForWorktree } from './worktree-teardown'
import { teardownFolderWorkspacePtys } from './folder-workspace-pty-teardown'
import { teardownStops } from './owned-session-teardown-policy'

type WorkspaceRegistrationRemovalRuntime = WorktreeTeardownRuntime &
  Pick<
    OrcaRuntimeWithRemoveManagedWorktree,
    | 'getLocalProvider'
    | 'onPtyStopped'
    | 'acquireFileWatcherRemoval'
    | 'clearOptimisticReconcileToken'
    | 'removeWorktreeMetadataAndHistory'
    | 'preservedBranchCleanup'
    | 'invalidateResolvedWorktreeCache'
    | 'invalidateWorktreeScanCacheForRepo'
    | 'notifyWorktreesChanged'
  >

export async function removeOrphanOrFolderWorktree({
  runtime,
  store,
  removalTarget,
  cleanupHostId,
  removalHostId,
  repo,
  archive
}: {
  runtime: WorkspaceRegistrationRemovalRuntime
  store: RuntimeStore
  removalTarget: RuntimeWorktreeRemovalTarget
  cleanupHostId?: ExecutionHostId
  removalHostId?: ExecutionHostId
  repo?: Repo
  /** Same opt-in as worktree removal: archive runs only when the caller asked for hooks. */
  archive: { runHooks: boolean; allowFailedArchiveHook: boolean }
}): Promise<(RemoveWorktreeResult & { warning?: string }) | undefined> {
  if (!repo) {
    const orphanHost = parseExecutionHostId(store.getWorktreeMeta(removalTarget.id)?.hostId)
    if (cleanupHostId && orphanHost?.id !== cleanupHostId) {
      throw new Error(
        `Workspace identity for ${removalTarget.id} no longer belongs to ${cleanupHostId}. Refresh projects and try again.`
      )
    }
    const ptyProvider = runtime.getLocalProvider()
    const externalOrphanHost = orphanHost?.kind === 'ssh' || orphanHost?.kind === 'runtime'
    if (ptyProvider) {
      await killAllProcessesForWorktree(removalTarget.id, {
        runtime,
        resolvedWorktreeId: removalTarget.id,
        ...(orphanHost?.kind === 'ssh' ? { resolvedConnectionId: orphanHost.targetId } : {}),
        ...(orphanHost?.kind === 'runtime'
          ? { resolvedRuntimeEnvironmentId: orphanHost.environmentId }
          : {}),
        localProvider: ptyProvider,
        onPtyStopped: runtime.onPtyStopped ?? undefined,
        // PTY sweeps miss structured chats; close them best-effort before forgetting the workspace.
        closeStructuredSessions: teardownStops('worktree-removal', 'structured-chat'),
        ...(externalOrphanHost
          ? { includeProviderInventory: false, includeLocalRegistry: false }
          : {})
      }).catch((error) => {
        console.warn(`[worktree-teardown] orphan cleanup failed for ${removalTarget.id}:`, error)
      })
    }
    const orphanFullPath = splitWorktreeId(removalTarget.id)?.worktreePath
    const orphanWatcherPath =
      splitWorktreeIdForFilesystem(removalTarget.id)?.worktreePath === orphanFullPath
        ? orphanFullPath
        : undefined
    if (orphanWatcherPath) {
      await runtime
        .acquireFileWatcherRemoval(
          orphanWatcherPath,
          orphanHost?.kind === 'ssh' ? orphanHost.targetId : undefined
        )
        .then((gate) => gate.finish(false))
        .catch(() => {})
    }
    runtime.clearOptimisticReconcileToken(removalTarget.id)
    await runtime.removeWorktreeMetadataAndHistory(
      store,
      removalTarget.id,
      cleanupHostId ?? orphanHost?.id
    )
    runtime.preservedBranchCleanup.delete(removalTarget.id, cleanupHostId)
    runtime.invalidateResolvedWorktreeCache()
    runtime.invalidateWorktreeScanCacheForRepo(removalTarget.repoId)
    invalidateAuthorizedRootsCache()
    runtime.notifyWorktreesChanged(removalTarget.repoId)
    return {
      warning: `Project ${removalTarget.repoId} is no longer tracked, so ${removalTarget.path} was forgotten without deleting the directory or its Git worktree registration.`
    }
  }

  if (!isFolderRepo(repo)) {
    return undefined
  }
  if (removalTarget.id === getRuntimeFolderWorkspaceRootId(repo)) {
    throw new Error('Cannot delete the project root workspace. Remove the folder project instead.')
  }
  // Archive failure must refuse before watcher, PTY or metadata teardown (#19334).
  const archiveHookOverride = await gateFolderWorkspaceRemovalOnArchiveHook({
    repo,
    worktreeId: removalTarget.id,
    displayName:
      (
        readWorktreeMetaForRepo(store, removalTarget.id, repo) ??
        store.getWorktreeMeta(removalTarget.id)
      )?.displayName ?? repo.displayName,
    runArchive: archive.runHooks,
    allowFailure: archive.allowFailedArchiveHook,
    runtimeTarget: () => getLocalProjectWorktreeGitOptions(store, repo)
  })
  // Without --run-hooks, look at the folder only to warn, and never start its stopped WSL distro for that.
  const archiveSkipped =
    !archive.runHooks &&
    isRepoOnCatalogHost(repo) &&
    !(await blockedWslDistroForPath(repo.path)) &&
    Boolean(getEffectiveHooks(repo)?.scripts.archive)
  // Use the resolved SSH owner, including executionHostId-only rows; runtime-nested targets belong to that environment's namespace.
  const folderHost = parseExecutionHostId(removalHostId)
  const folderConnectionId = folderHost?.kind === 'ssh' ? folderHost.targetId : null
  const gate = await runtime.acquireFileWatcherRemoval(repo.path, folderConnectionId ?? undefined)
  try {
    await teardownFolderWorkspacePtys(
      {
        runtime,
        getLocalProvider: () => runtime.getLocalProvider(),
        onPtyStopped: runtime.onPtyStopped
      },
      removalTarget.id,
      folderConnectionId
    )
    await runtime.removeWorktreeMetadataAndHistory(store, removalTarget.id, removalHostId)
    removeFolderWorkspaceRunnerFiles(repo, removalTarget.id)
    runtime.preservedBranchCleanup.delete(removalTarget.id, cleanupHostId)
    runtime.invalidateResolvedWorktreeCache()
    runtime.notifyWorktreesChanged(repo.id)
    return {
      ...(archiveHookOverride ? { archiveHookOverride } : {}),
      ...(archiveSkipped
        ? {
            warning:
              'orca.yaml archive hook skipped for this folder workspace; pass --run-hooks to run it.'
          }
        : {})
    }
  } finally {
    await gate.finish(false)
  }
}
