import { createCwdContainment, isOnCallerFilesystem } from './caller-cwd-containment'
import { getCallerExecutionHostId } from './caller-host-worktree-selection'
import { resolveQualifiedFolderWorkspaceResult } from '../../shared/folder-workspaces/folder-workspace-execution-host'
import type { FolderWorkspace } from '../../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import type { RuntimeWorktreeListResult } from '../../shared/runtime-worktree-contracts'
import { folderWorkspaceKey } from '../../shared/workspace-scope'
import type { CatalogRow } from './workspace-catalog-row'
import type { RuntimeClient } from '../runtime/client'
import { RuntimeClientError } from '../runtime/types'

/** An older Orca without the folder catalog keeps its repo-backed rows; any other failure is real. */
async function readOptional<TResult>(read: Promise<TResult>): Promise<TResult | undefined> {
  try {
    return await read
  } catch (error) {
    if (error instanceof RuntimeClientError && error.code === 'method_not_found') {
      return undefined
    }
    throw error
  }
}

/**
 * Repo-backed rows plus the folder workspaces that enclose cwd, each with its derived host so the
 * caller-host rules apply to both kinds. A folder whose host can't be derived stays in, marked
 * unresolved, so selection refuses rather than silently skipping a possible owner.
 */
export async function readEnclosingWorkspaceCatalog(
  client: RuntimeClient,
  cwd: string
): Promise<CatalogRow[]> {
  const [worktrees, folders] = await Promise.all([
    client.call<RuntimeWorktreeListResult>('worktree.list', { limit: 10_000 }),
    readOptional(client.call<{ folderWorkspaces: FolderWorkspace[] }>('folderWorkspace.list'))
  ])
  const rows: CatalogRow[] = worktrees.result.worktrees
  const allFolders = folders?.result.folderWorkspaces ?? []
  if (allFolders.length === 0) {
    return rows
  }
  // Hosts come first: only a folder on the caller's own filesystem may be resolved locally.
  const [groups, repos] = await Promise.all([
    readOptional(client.call<{ groups: ProjectGroup[] }>('projectGroup.list')),
    readOptional(client.call<{ repos: Repo[] }>('repo.list'))
  ])
  const contains = createCwdContainment(cwd, getCallerExecutionHostId())
  const folderRows = allFolders.flatMap((folder): CatalogRow[] => {
    const host =
      groups && repos
        ? resolveQualifiedFolderWorkspaceResult(
            {
              folderWorkspaces: [folder],
              projectGroups: groups.result.groups,
              repos: repos.result.repos
            },
            folder.id
          )
        : null
    const base = { id: folderWorkspaceKey(folder.id), path: folder.folderPath }
    const row: CatalogRow =
      host?.kind === 'selected'
        ? { ...base, hostId: host.value.hostId }
        : { ...base, hostUnresolved: true }
    return contains(row.path, isOnCallerFilesystem(row)) === null ? [] : [row]
  })
  return [...rows, ...folderRows]
}
