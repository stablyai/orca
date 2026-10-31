import type { RuntimeProjectGroupDependencies } from '../runtime-project-group-controller'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import {
  assertWslMoveProjectWritable,
  isLocalWslMoveRow
} from '../../persistence/moving-wsl-projects/wsl-move-scope-guard'
import {
  withWorkspaceServerRemoval,
  stopWorkspaceServersForRemoval
} from '../../servers/workspace-server-removal'

export async function removeFloatingFolderWorkspace(
  deps: RuntimeProjectGroupDependencies,
  folderWorkspaceId: string
): Promise<{ deleted: boolean }> {
  const store = deps.getStore()
  if (!store?.removeFolderWorkspace) {
    throw new Error('runtime_unavailable')
  }
  const removeFolderWorkspace = store.removeFolderWorkspace.bind(store)
  const workspace = store.getFolderWorkspaces?.().find((entry) => entry.id === folderWorkspaceId)
  if (workspace && isLocalWslMoveRow(workspace)) {
    assertWslMoveProjectWritable(store, { folderWorkspaceId })
  }
  // Mixed-host groups have no single PTY target; skip the sweep so forgetting still succeeds.
  let connectionId: string | null | undefined
  try {
    connectionId = workspace ? deps.resolveFolderConnectionId(workspace) : null
  } catch (error) {
    console.warn(
      `[folder-workspace] skipping PTY teardown for ${folderWorkspaceKey(folderWorkspaceId)}:`,
      error
    )
  }
  const serverHost =
    connectionId === null ? 'local' : connectionId ? 'ssh' : (workspace?.executionHostId ?? 'local')
  return withWorkspaceServerRemoval(
    deps,
    folderWorkspaceKey(folderWorkspaceId),
    serverHost,
    async () => {
      if (workspace) {
        const worktreeId = folderWorkspaceKey(folderWorkspaceId)
        // Managed children must stop even when PTY teardown is unavailable or best-effort.
        await stopWorkspaceServersForRemoval(deps, worktreeId, serverHost)
        if (connectionId !== undefined) {
          await deps.teardownFolderWorkspacePtys(worktreeId, connectionId)
        }
        deps.cleanupRemovedFolderWorkspaceState(worktreeId)
      }
      const deleted = removeFolderWorkspace(folderWorkspaceId)
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
      return { deleted }
    }
  )
}
