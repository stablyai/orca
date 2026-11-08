import { createCwdContainment } from './caller-cwd-containment'
import { getCallerExecutionHostId } from './caller-host-worktree-selection'
import { resolveQualifiedFolderWorkspaceResult } from '../shared/folder-workspaces/folder-workspace-execution-host'
import type { FolderWorkspace } from '../shared/folder-workspaces/folder-workspace-types'
import type { ProjectGroup } from '../shared/project-group-types'
import type { Repo } from '../shared/repo-types'
import type { RuntimeWorktreeListResult } from '../shared/runtime-types'
import { folderWorkspaceKey, parseWorkspaceKey } from '../shared/workspace-scope'
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

/** An innermost folder with an unknown host can't be ruled in or out, so no owner is guessed. */
export function refuseUnresolvedOwner(innermost: readonly CatalogRow[]): void {
  const unresolved = innermost.filter((row) => row.hostUnresolved)
  if (unresolved.length === 0) {
    return
  }
  throw new RuntimeClientError(
    'selector_ambiguous',
    `Orca can't tell which host owns the folder workspace containing the current directory (${unresolved.map((row) => `${row.id} at ${row.path}`).join(', ')}), so it won't guess the workspace.`,
    {
      workspaces: innermost.map((row) => ({
        kind: parseWorkspaceKey(row.id)?.type === 'folder' ? 'folder workspace' : 'worktree',
        id: row.id,
        path: row.path,
        hostId: row.hostUnresolved ? null : (row.hostId ?? 'local')
      })),
      nextSteps: [
        ...unresolved.map(
          (row) => `Pass --worktree ${row.id} to target the folder workspace itself.`
        ),
        'Or pass an explicit worktree selector from `orca worktree ps --json`.'
      ]
    }
  )
}
