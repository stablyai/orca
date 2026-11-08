import { createCwdContainment } from './caller-cwd-containment'
import { getCallerExecutionHostId } from './caller-host-worktree-selection'
import { resolveQualifiedFolderWorkspaceResult } from '../shared/folder-workspaces/folder-workspace-execution-host'
import type { FolderWorkspace } from '../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../shared/project-group-types'
import type { Repo } from '../shared/repo-types'
import type { RuntimeWorktreeListResult } from '../shared/runtime-types'
import { folderWorkspaceKey } from '../shared/workspace-scope'
import type { CatalogRow } from './workspace-catalog-row'
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
  // A folder's host isn't derived yet; the selection rule applies host scope afterwards.
  const contains = createCwdContainment(cwd, getCallerExecutionHostId())
  const enclosing = (folders?.result.folderWorkspaces ?? []).filter(
    (folder) => contains(folder.folderPath) !== null
  )
  if (enclosing.length === 0) {
    return rows
  }
  // Host derivation needs groups and repos; read them only when a folder can own cwd.
  const [groups, repos] = await Promise.all([
    readOptional(client.call<{ groups: ProjectGroup[] }>('projectGroup.list')),
    readOptional(client.call<{ repos: Repo[] }>('repo.list'))
  ])
  const folderRows = enclosing.map((folder): CatalogRow => {
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
    const row = { id: folderWorkspaceKey(folder.id), path: folder.folderPath }
    return host?.kind === 'selected'
      ? { ...row, hostId: host.value.hostId }
      : { ...row, hostUnresolved: true }
  })
  return [...rows, ...folderRows]
}
