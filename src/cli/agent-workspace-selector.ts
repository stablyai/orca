import type { FolderWorkspace } from '../shared/folder-workspace-types'
import type { ProjectGroup } from '../shared/project-group-types'
import type { Repo } from '../shared/repo-types'
import { resolveFolderWorkspaceHost } from '../shared/folder-workspace-execution-host'
import { LOCAL_EXECUTION_HOST_ID } from '../shared/execution-host'
import {
  getCallerExecutionHostId,
  selectEnclosingWorktreeOnHost
} from './caller-host-worktree-selection'
import { RuntimeRpcFailureError, type RuntimeClient } from './runtime-client'
import { resolveCurrentWorktreeSelector } from './selectors'

/** Native folders take precedence over enclosing Git checkouts; remote cwd keeps its host rules. */
export async function resolveCurrentAgentWorkspaceSelector(
  cwd: string,
  client: RuntimeClient
): Promise<string> {
  if (!client.isRemote && getCallerExecutionHostId() === LOCAL_EXECUTION_HOST_ID) {
    try {
      const folders = await client.call<{ folderWorkspaces: FolderWorkspace[] }>(
        'folderWorkspace.list'
      )
      const catalog = folders.result.folderWorkspaces.map((folder) => ({
        id: `folder:${folder.id}`,
        path: folder.folderPath
      }))
      if (selectEnclosingWorktreeOnHost(catalog, cwd, LOCAL_EXECUTION_HOST_ID)) {
        const [groups, repos] = await Promise.all([
          client.call<{ groups: ProjectGroup[] }>('projectGroup.list'),
          client.call<{ repos: Repo[] }>('repo.list')
        ])
        const state = {
          folderWorkspaces: folders.result.folderWorkspaces,
          projectGroups: groups.result.groups,
          repos: repos.result.repos
        }
        const nativeCatalog = catalog.filter(
          (row) =>
            resolveFolderWorkspaceHost(state, row.id.slice('folder:'.length)).kind === 'local'
        )
        const callerWorkspace = process.env.ORCA_WORKSPACE_ID ?? process.env.ORCA_WORKTREE_ID
        const callerCatalog = nativeCatalog.filter((row) => row.id === callerWorkspace)
        const selector =
          selectEnclosingWorktreeOnHost(callerCatalog, cwd, LOCAL_EXECUTION_HOST_ID) ??
          selectEnclosingWorktreeOnHost(nativeCatalog, cwd, LOCAL_EXECUTION_HOST_ID)
        if (selector) {
          return selector
        }
      }
    } catch (error) {
      // An older host may lack the folder catalog; a failed catalog must not select a wrong checkout.
      if (!(error instanceof RuntimeRpcFailureError) || error.code !== 'method_not_found') {
        throw error
      }
    }
  }
  return resolveCurrentWorktreeSelector(cwd, client)
}
