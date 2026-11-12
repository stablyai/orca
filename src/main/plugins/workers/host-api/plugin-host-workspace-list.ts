import { z } from 'zod'
import type { PluginHostResult } from '../../../../shared/plugins/workers/plugin-host-api'
import {
  PLUGIN_PROJECT_LIST_LIMIT,
  PLUGIN_WORKSPACE_LIST_LIMIT,
  pluginWorkspaceId
} from '../../../../shared/plugins/workers/plugin-host-api-workspace-methods'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { PluginRuntimeRpc } from './plugin-host-runtime-call'

type WorkspaceList = PluginHostResult<'workspace.list'>
type WorkspaceStatus = NonNullable<WorkspaceList['workspaces'][number]['status']>

// The parts of each runtime answer `workspace.list` and `project.list` read; the rest is dropped.
const worktreeListAnswer = z.object({
  worktrees: z.array(
    z.object({
      id: z.string(),
      repoId: z.string(),
      displayName: z.string(),
      path: z.string(),
      branch: z.string().optional(),
      hostId: z.string().optional(),
      identity: z.object({ key: z.string() }).optional()
    })
  ),
  totalCount: z.number().optional(),
  truncated: z.boolean().optional()
})
const repoRow = z.object({
  id: z.string(),
  kind: z.string().optional(),
  displayName: z.string().optional()
})
const repoListAnswer = z.object({ repos: z.array(repoRow) })
const projectListAnswer = z.object({
  repos: z.array(
    repoRow.extend({
      path: z.string(),
      executionHostId: z.string().nullable().optional(),
      connectionId: z.string().nullable().optional()
    })
  )
})
const folderListAnswer = z.object({
  folderWorkspaces: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      folderPath: z.string(),
      executionHostId: z.string().nullable().optional()
    })
  )
})
const worktreePsAnswer = z.object({
  worktrees: z.array(
    z.object({
      worktreeId: z.string(),
      identity: z.object({ key: z.string() }).optional(),
      status: z.enum(['working', 'permission', 'done', 'active', 'inactive']),
      unread: z.boolean(),
      liveTerminalCount: z.number().int().nonnegative(),
      lastOutputAt: z.number().finite().nullable().optional(),
      lastActivityAt: z.number().finite().optional()
    })
  )
})

/** `refs/heads/main` reads as `main`; a detached or folder workspace has none. */
function branchName(branch: string | undefined): string | null {
  const name = branch?.replace(/^refs\/heads\//, '') ?? ''
  return name || null
}

/** Each workspace's status by the id `workspace.list` gives it. */
async function workspaceStatuses(call: PluginRuntimeRpc): Promise<Map<string, WorkspaceStatus>> {
  const { worktrees } = worktreePsAnswer.parse(
    await call('worktree.ps', { limit: PLUGIN_WORKSPACE_LIST_LIMIT })
  )
  return new Map(
    worktrees.map((row) => [
      // Folder workspace rows carry their `folder:` key as worktreeId, as list rows do.
      pluginWorkspaceId({ id: row.worktreeId, identityKey: row.identity?.key }),
      {
        state: row.status,
        unread: row.unread,
        terminalCount: row.liveTerminalCount,
        lastActivityAt: row.lastOutputAt ?? row.lastActivityAt ?? null
      }
    ])
  )
}

/** `workspace.list`: Git worktrees (and folder projects), then project-group folders. */
export async function listPluginWorkspaces(
  call: PluginRuntimeRpc,
  includeStatus: boolean
): Promise<WorkspaceList> {
  const [listed, repos, folderList, statuses] = await Promise.all([
    call('worktree.list', { limit: PLUGIN_WORKSPACE_LIST_LIMIT }),
    call('repo.list', {}),
    call('folderWorkspace.list', undefined),
    includeStatus ? workspaceStatuses(call) : null
  ])
  const { worktrees, totalCount, truncated } = worktreeListAnswer.parse(listed)
  const repoRows = repoListAnswer.parse(repos).repos
  const folderRepos = new Set(
    repoRows.filter((repo) => repo.kind === 'folder').map((repo) => repo.id)
  )
  const projectNames = new Map(repoRows.map((repo) => [repo.id, repo.displayName || null]))
  const withStatus = <Row extends { id: string }>(row: Row) => {
    const status = statuses?.get(row.id)
    return status ? { ...row, status } : row
  }
  const worktreeRows = worktrees.slice(0, PLUGIN_WORKSPACE_LIST_LIMIT).map((worktree) => {
    const folder = folderRepos.has(worktree.repoId)
    return withStatus({
      id: pluginWorkspaceId({ id: worktree.id, identityKey: worktree.identity?.key }),
      kind: folder ? ('folder' as const) : ('worktree' as const),
      name: worktree.displayName,
      project: projectNames.get(worktree.repoId)?.slice(0, 512) ?? null,
      projectId: worktree.repoId,
      path: worktree.path,
      branch: folder ? null : branchName(worktree.branch),
      hostId: worktree.hostId ?? null
    })
  })
  // Project-group folders have no repo row; their key is what selectors take.
  const projectFolders = folderListAnswer.parse(folderList).folderWorkspaces.map((folder) =>
    withStatus({
      id: folderWorkspaceKey(folder.id),
      kind: 'folder' as const,
      name: folder.name,
      project: null,
      projectId: null,
      path: folder.folderPath,
      branch: null,
      hostId: folder.executionHostId ?? null
    })
  )
  const room = PLUGIN_WORKSPACE_LIST_LIMIT - worktreeRows.length
  return {
    workspaces: [...worktreeRows, ...projectFolders.slice(0, room)],
    truncated:
      truncated === true ||
      (totalCount ?? worktrees.length) > worktreeRows.length ||
      projectFolders.length > room
  }
}

/** `project.list`: the repositories and folders `repo.list` shows, which hides retired rows. */
export async function listPluginProjects(
  call: PluginRuntimeRpc
): Promise<PluginHostResult<'project.list'>> {
  const { repos } = projectListAnswer.parse(await call('repo.list', {}))
  return {
    projects: repos.slice(0, PLUGIN_PROJECT_LIST_LIMIT).map((repo) => ({
      id: repo.id,
      name: (repo.displayName ?? '').slice(0, 512),
      kind: repo.kind === 'folder' ? ('folder' as const) : ('git' as const),
      // The same host a list row names: null when the repo records none (this machine).
      hostId: repo.executionHostId || repo.connectionId ? getRepoExecutionHostId(repo) : null,
      path: repo.path
    })),
    truncated: repos.length > PLUGIN_PROJECT_LIST_LIMIT
  }
}
