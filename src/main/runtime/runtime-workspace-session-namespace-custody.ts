import { RuntimeWorkspaceSessionController } from './runtime-workspace-session-controller'
import { inferFolderWorkspacePathConnection } from '../project-groups/folder-workspace-path-status'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../shared/worktree/id'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import type { Store } from '../persistence'

export function hasMainOwnedRuntimeSessionNamespace(store: Store, hostId: string): boolean {
  if (parseExecutionHostId(hostId)?.kind !== 'runtime') {
    return false
  }
  const repos = store.getRepos()
  const folders = store.getFolderWorkspaces()
  if (repos.some((repo) => getRepoExecutionHostId(repo) === hostId)) {
    return true
  }
  if (folders.some((folder) => parseExecutionHostId(folder.executionHostId)?.id === hostId)) {
    return true
  }

  const controller = new RuntimeWorkspaceSessionController({
    getStore: () => store,
    resolveFolderConnectionId: (workspace) => {
      const connection = inferFolderWorkspacePathConnection({
        folderPath: workspace.folderPath,
        projectGroupId: workspace.projectGroupId,
        connectionId: workspace.connectionId ?? null,
        projectGroups: store.getProjectGroups(),
        repos
      })
      if (connection.kind === 'ambiguous') {
        throw new Error('folder_workspace_connection_ambiguous')
      }
      return connection.kind === 'ssh' ? connection.connectionId : null
    },
    hasRuntimeOwnedPtyCandidate: () => false
  })
  for (const workspaceId of Object.keys(store.getWorkspaceSession(hostId).tabsByWorktree)) {
    const scope = parseWorkspaceKey(workspaceId)
    const catalogHost =
      scope?.type === 'folder'
        ? folders.find((folder) => folder.id === scope.folderWorkspaceId)?.executionHostId
        : (() => {
            const repo = store.getRepo(
              getRepoIdFromWorktreeId(scope?.type === 'worktree' ? scope.worktreeId : workspaceId)
            )
            return repo ? getRepoExecutionHostId(repo) : null
          })()
    // Only a current runtime-owned catalog row can exercise the controller's legacy alias fallback.
    if (
      parseExecutionHostId(catalogHost)?.kind === 'runtime' &&
      controller.tryGetHostId(workspaceId) === hostId
    ) {
      return true
    }
  }
  return false
}
