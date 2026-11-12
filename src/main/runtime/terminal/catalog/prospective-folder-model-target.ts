import type { TerminalModelDiscoveryParams } from '../../../../shared/rpc-contract/agent-model-discovery-params'
import type { FolderWorkspace } from '../../../../shared/folder-workspaces/folder-workspace-types'
import {
  findLocalFolderWorkspaceRuntimeRepo,
  resolveFolderWorkspaceRowHost
} from '../../../../shared/folder-workspaces/folder-workspace-execution-host'
import type { RuntimeStore } from '../../construction/runtime-store-contract'
import type { ResolvedTerminalWorkspaceLaunchTarget } from '../launch/terminal-workspace-launch-target'

/** Match folder creation's inputs without creating the workspace or its directory. */
export function prospectiveFolderModelTarget(
  store: RuntimeStore,
  input: NonNullable<TerminalModelDiscoveryParams['folder']>
): ResolvedTerminalWorkspaceLaunchTarget {
  const projectGroups = store.getProjectGroups?.() ?? []
  const group = projectGroups.find(({ id }) => id === input.projectGroupId)
  const folderPath = input.folderPath?.trim() ? input.folderPath : group?.parentPath?.trim()
  if (!group || !folderPath) {
    throw new Error('folder_workspace_project_group_not_found')
  }
  const folder: FolderWorkspace = {
    id: '',
    projectGroupId: group.id,
    name: '',
    folderPath,
    connectionId: input.connectionId ?? group.connectionId ?? null,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  }
  const catalog = { folderWorkspaces: [folder], projectGroups, repos: store.getRepos() }
  const host = resolveFolderWorkspaceRowHost(catalog, folder)
  if (host.kind !== 'local') {
    throw new Error('terminal_model_execution_host_unavailable')
  }
  return {
    scope: {
      id: '',
      path: folderPath,
      connectionId: null,
      repo: findLocalFolderWorkspaceRuntimeRepo(catalog, folder.id, folder) ?? null,
      folderWorkspace: folder
    },
    managedWorktree: null
  }
}
