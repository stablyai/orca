import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import {
  assertWslMoveProjectWritable,
  isLocalWslMoveRow
} from '../../persistence/moving-wsl-projects/quiescence/wsl-move-scope-guard'
import {
  assertUniqueIdWhenRequired,
  type FolderWorkspaceMutationOptions
} from './folder-workspace-unique-id-mutation'
import type { RuntimeProjectGroupDependencies } from './runtime-project-group-controller'

export async function deleteFolderWorkspaceRow(
  deps: RuntimeProjectGroupDependencies,
  folderWorkspaceId: string,
  options: FolderWorkspaceMutationOptions
): Promise<{ deleted: boolean }> {
  const store = deps.getStore()
  if (!store?.removeFolderWorkspace) {
    throw new Error('runtime_unavailable')
  }
  assertUniqueIdWhenRequired(store, folderWorkspaceId, options)
  const workspace = store.getFolderWorkspaces?.().find((entry) => entry.id === folderWorkspaceId)
  if (options.requireUniqueId && !workspace) {
    return { deleted: false }
  }
  if (workspace && isLocalWslMoveRow(workspace)) {
    assertWslMoveProjectWritable(store, { folderWorkspaceId })
  }
  let gate:
    | Awaited<ReturnType<RuntimeProjectGroupDependencies['acquireFileWatcherRemoval']>>
    | undefined
  let cleanupState: void | Promise<void> = undefined
  try {
    if (workspace) {
      const worktreeId = folderWorkspaceKey(folderWorkspaceId)
      // Mixed-host groups have no single PTY target; skip the sweep so forgetting still succeeds.
      let connectionId: string | null | undefined
      try {
        connectionId = deps.resolveFolderConnectionId(workspace)
      } catch (error) {
        console.warn(`[folder-workspace] skipping PTY teardown for ${worktreeId}:`, error)
      }
      if (connectionId !== undefined) {
        gate = await deps.acquireFileWatcherRemoval(workspace.folderPath, connectionId ?? undefined)
        await deps.teardownFolderWorkspacePtys(worktreeId, connectionId)
      }
      // Twins share every record keyed by the id, so a twin added during teardown stops the delete here.
      assertUniqueIdWhenRequired(
        store,
        folderWorkspaceId,
        options,
        'Its terminals may already be stopped; nothing else was changed.'
      )
      // Fired here (timing unchanged) but awaited at the end: the delete may
      // only resolve after the purge has landed. `folder:<uuid>` ids parse to
      // no filesystem path, so the pretrust drop inside the purge skips here —
      // safe: the folder itself stays and sibling workspaces may share its path.
      cleanupState = deps.cleanupRemovedFolderWorkspaceState(worktreeId)
    }
    const deleted = store.removeFolderWorkspace(folderWorkspaceId)
    if (deleted) {
      deps.notifyReposChanged()
      // The same removal a worktree announces, so its consumers end work held there too.
      if (workspace) {
        deps.emitWorktreeLifecycle({
          kind: 'removed',
          worktreeId: folderWorkspaceKey(folderWorkspaceId),
          path: workspace.folderPath
        })
      }
    }
    await cleanupState
    return { deleted }
  } finally {
    await gate?.finish(false)
  }
}
