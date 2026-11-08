import { resolve as resolvePath } from 'node:path'
import { isPathInsideOrEqual } from '../shared/cross-platform-path'
import { resolveQualifiedFolderWorkspaceResult } from '../shared/folder-workspaces/folder-workspace-execution-host'
import type { FolderWorkspace } from '../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../shared/project-group-types'
import type { Repo } from '../shared/repo-types'
import type { RuntimeWorktreeListResult } from '../shared/runtime-types'
import { folderWorkspaceKey } from '../shared/workspace-scope'
import type { CatalogRow } from './caller-host-worktree-selection'
import type { RuntimeClient } from './runtime-client'
import { RuntimeClientError } from './runtime/types'

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
 * caller-host rules apply to both kinds. A folder whose host can't be derived is left out.
 */
export async function readEnclosingWorkspaceCatalog(
  client: RuntimeClient,
  cwd: string,
  readWorktrees: () => Promise<RuntimeWorktreeListResult['worktrees']> = async () =>
    (await client.call<RuntimeWorktreeListResult>('worktree.list', { limit: 10_000 })).result
      .worktrees
): Promise<CatalogRow[]> {
  const [worktrees, folders] = await Promise.all([
    readWorktrees(),
    readOptional(client.call<{ folderWorkspaces: FolderWorkspace[] }>('folderWorkspace.list'))
  ])
  const rows: CatalogRow[] = worktrees
  const currentPath = resolvePath(cwd)
  const enclosing = (folders?.result.folderWorkspaces ?? []).filter((folder) =>
    isPathInsideOrEqual(resolvePath(folder.folderPath), currentPath)
  )
  if (enclosing.length === 0) {
    return rows
  }
  // Host derivation needs groups and repos; read them only when a folder can own cwd.
  const [groups, repos] = await Promise.all([
    readOptional(client.call<{ groups: ProjectGroup[] }>('projectGroup.list')),
    readOptional(client.call<{ repos: Repo[] }>('repo.list'))
  ])
  if (!groups || !repos) {
    return rows
  }
  const folderRows = enclosing.flatMap((folder): CatalogRow[] => {
    const host = resolveQualifiedFolderWorkspaceResult(
      {
        folderWorkspaces: [folder],
        projectGroups: groups.result.groups,
        repos: repos.result.repos
      },
      folder.id
    )
    return host.kind === 'selected'
      ? [{ id: folderWorkspaceKey(folder.id), path: folder.folderPath, hostId: host.value.hostId }]
      : []
  })
  return [...rows, ...folderRows]
}
