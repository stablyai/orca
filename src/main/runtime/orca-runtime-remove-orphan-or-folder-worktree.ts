// @ts-nocheck -- mechanically split from OrcaRuntimeService.
import { splitWorktreeId, splitWorktreeIdForFilesystem } from '../../shared/worktree/id'
import { parseExecutionHostId } from '../../shared/execution-host'
import { deleteRemoteWorktreeHistory } from '../remote-worktree-history-cleanup'
import { invalidateAuthorizedRootsCache } from '../ipc/filesystem-auth'
import { isFolderRepo } from '../../shared/repo-kind'
import { getRuntimeFolderWorkspaceRootId } from './runtime-folder-workspace'
import { killAllProcessesForWorktree } from './worktree-teardown'
import { teardownFolderWorkspacePtys } from './folder-workspace-pty-teardown'

export async function removeOrphanOrFolderWorktree({
  runtime,
  store,
  removalTarget,
  cleanupHostId,
  removalHostId,
  repo
}: {
  runtime: unknown
  store: unknown
  removalTarget: unknown
  cleanupHostId?: string
  removalHostId?: string
  repo?: unknown
}): Promise<{ warning?: string } | undefined> {
  if (!repo) {
    const orphanHost = parseExecutionHostId(store.getWorktreeMeta(removalTarget.id)?.hostId)
    if (cleanupHostId && orphanHost?.id !== cleanupHostId) {
      throw new Error(
        `Workspace identity for ${removalTarget.id} no longer belongs to ${cleanupHostId}. Refresh projects and try again.`
      )
    }
    const sshPtyProvider =
      orphanHost?.kind === 'ssh' ? runtime.getSshProviderFn?.(orphanHost.targetId) : undefined
    const ptyProvider = sshPtyProvider ?? runtime.getLocalProvider()
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
        ...(externalOrphanHost
          ? {
              includeProviderInventory: orphanHost?.kind === 'ssh' && Boolean(sshPtyProvider),
              includeLocalRegistry: false
            }
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
    await deleteRemoteWorktreeHistory(sshPtyProvider, removalTarget.id)
    runtime.clearOptimisticReconcileToken(removalTarget.id)
    runtime.removeWorktreeMetadataAndHistory(
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
  const folderConnectionId = repo.connectionId?.trim() || null
  const folderSshPtyProvider = folderConnectionId
    ? runtime.getSshProviderFn?.(folderConnectionId)
    : undefined
  await teardownFolderWorkspacePtys(
    {
      runtime,
      getSshProvider: runtime.getSshProviderFn,
      getLocalProvider: () => runtime.getLocalProvider(),
      onPtyStopped: runtime.onPtyStopped
    },
    removalTarget.id,
    folderConnectionId
  )
  await deleteRemoteWorktreeHistory(folderSshPtyProvider, removalTarget.id)
  runtime.removeWorktreeMetadataAndHistory(store, removalTarget.id, removalHostId)
  runtime.preservedBranchCleanup.delete(removalTarget.id, cleanupHostId)
  runtime.invalidateResolvedWorktreeCache()
  runtime.notifyWorktreesChanged(repo.id)
  return {}
}
