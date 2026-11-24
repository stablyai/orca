import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host/execution-host'
import { resolveQualifiedFolderWorkspaceResult } from '../../../shared/folder-workspaces/folder-workspace-execution-host'
import { parseWslUncPath } from '../../../shared/file-access/wsl-paths'
import { parseWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import type { Store } from '../../persistence/loading-store/store'
import type { OrcaRuntimeService } from '../../runtime/orca-runtime'

export function createMimoHistoryWorkspacePathResolver(
  store: Pick<Store, 'getFolderWorkspaces' | 'getProjectGroups' | 'getRepos'>,
  runtime: Pick<
    OrcaRuntimeService,
    'resolveStructuredHistoryLocalWorkspacePath' | 'resolveStructuredAgentCatalogWorkspacePath'
  >
) {
  return async (workspaceId: string, selected: boolean): Promise<string | null> => {
    const key = parseWorkspaceKey(workspaceId)
    if (key?.type === 'folder') {
      const folder = resolveQualifiedFolderWorkspaceResult(
        {
          folderWorkspaces: store.getFolderWorkspaces(),
          projectGroups: store.getProjectGroups(),
          repos: store.getRepos()
        },
        key.folderWorkspaceId,
        LOCAL_EXECUTION_HOST_ID
      )
      const path = folder.kind === 'selected' ? folder.value.workspace.folderPath : null
      return path && !parseWslUncPath(path) ? path : null
    }
    // Broad History must not scan the fleet to resolve paths for past chats.
    const selector = `id:${workspaceId}`
    return selected
      ? runtime.resolveStructuredHistoryLocalWorkspacePath(workspaceId)
      : runtime.resolveStructuredAgentCatalogWorkspacePath(selector)
  }
}
