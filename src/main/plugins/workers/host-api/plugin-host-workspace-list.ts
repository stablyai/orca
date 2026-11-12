import { z } from 'zod'
import type { PluginHostResult } from '../../../../shared/plugins/workers/plugin-host-api'
import {
  PLUGIN_HOST_ID_MAX_LENGTH,
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
  displayName: z.string().optional(),
  executionHostId: z.string().nullable().optional(),
  connectionId: z.string().nullable().optional()
})
const repoListAnswer = z.object({ repos: z.array(repoRow) })
const projectListAnswer = z.object({
  repos: z.array(repoRow.extend({ path: z.string() }))
})
const folderListAnswer = z.object({
  folderWorkspaces: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      folderPath: z.string(),
      executionHostId: z.string().nullable().optional(),
      connectionId: z.string().nullable().optional()
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
  ),
  totalCount: z.number().optional(),
  truncated: z.boolean().optional()
})

/** `refs/heads/main` reads as `main`; a detached or folder workspace has none. */
function branchName(branch: string | undefined): string | null {
  const name = branch?.replace(/^refs\/heads\//, '') ?? ''
  return name || null
}

type WorkspaceStatuses = { byId: Map<string, WorkspaceStatus>; truncated: boolean }

/** Each workspace's status by the id `workspace.list` gives it. */
async function readWorkspaceStatuses(call: PluginRuntimeRpc): Promise<WorkspaceStatuses> {
  const { worktrees, totalCount, truncated } = worktreePsAnswer.parse(
    await call('worktree.ps', { limit: PLUGIN_WORKSPACE_LIST_LIMIT })
  )
  return {
    byId: new Map(
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
    ),
    truncated: truncated === true || (totalCount ?? worktrees.length) > worktrees.length
  }
}

export const PLUGIN_WORKSPACE_STATUS_TTL_MS = 1000
// Why shared: `worktree.ps` refreshes every terminal host, so plugins polling together share
// one listing in flight and its answer for a second. Keyed by the runtime RPC it came from.
const statusReads = new WeakMap<object, { at: number; read: Promise<WorkspaceStatuses> }>()

function workspaceStatuses(call: PluginRuntimeRpc, source: object): Promise<WorkspaceStatuses> {
  const now = Date.now()
  const cached = statusReads.get(source)
  if (cached && now - cached.at < PLUGIN_WORKSPACE_STATUS_TTL_MS) {
    return cached.read
  }
  const read = readWorkspaceStatuses(call)
  statusReads.set(source, { at: now, read })
  // A failed listing is not kept: the next call asks again.
  read.catch(() => {
    if (statusReads.get(source)?.read === read) {
      statusReads.delete(source)
    }
  })
  return read
}

type HostOwner = { executionHostId?: string | null; connectionId?: string | null }

/** One convention for every list: `local` for this machine, else the `ssh:`/`runtime:` host. */
function pluginHostId(owner: HostOwner | undefined): string {
  return getRepoExecutionHostId(owner ?? {})
}

/** Whether a row's ids and path fit the public bounds; one that does not is left out. */
function fitsBounds(row: {
  id: string
  path: string
  hostId: string | null
  projectId?: string | null
}): boolean {
  return [row.id, row.path, row.hostId ?? '', row.projectId ?? ''].every(
    (value) => value.length <= PLUGIN_HOST_ID_MAX_LENGTH
  )
}

/**
 * `workspace.list`: Git worktrees (and folder projects), then project-group folders. With
 * `includeStatus`, each row Orca has a status for carries it. `statusSource` keys the shared
 * status listing (the runtime RPC the call came through).
 */
export async function listPluginWorkspaces(
  call: PluginRuntimeRpc,
  includeStatus: boolean,
  statusSource: object = call
): Promise<WorkspaceList> {
  const [listed, repos, folderList, statuses] = await Promise.all([
    call('worktree.list', { limit: PLUGIN_WORKSPACE_LIST_LIMIT }),
    call('repo.list', {}),
    call('folderWorkspace.list', undefined),
    includeStatus ? workspaceStatuses(call, statusSource) : null
  ])
  const { worktrees, totalCount, truncated } = worktreeListAnswer.parse(listed)
  const repoRows = repoListAnswer.parse(repos).repos
  const reposById = new Map(repoRows.map((repo) => [repo.id, repo]))
  const withStatus = <Row extends { id: string }>(row: Row) => {
    const status = statuses?.byId.get(row.id)
    return status ? { ...row, status } : row
  }
  const worktreeRows = worktrees.slice(0, PLUGIN_WORKSPACE_LIST_LIMIT).map((worktree) => {
    const repo = reposById.get(worktree.repoId)
    const folder = repo?.kind === 'folder'
    return withStatus({
      id: pluginWorkspaceId({ id: worktree.id, identityKey: worktree.identity?.key }),
      kind: folder ? ('folder' as const) : ('worktree' as const),
      name: worktree.displayName,
      project: repo?.displayName?.slice(0, 512) || null,
      projectId: worktree.repoId,
      path: worktree.path,
      branch: folder ? null : branchName(worktree.branch),
      hostId: worktree.hostId ?? pluginHostId(repo)
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
      hostId: pluginHostId(folder)
    })
  )
  const room = PLUGIN_WORKSPACE_LIST_LIMIT - worktreeRows.length
  const candidates = [...worktreeRows, ...projectFolders.slice(0, room)]
  const workspaces = candidates.filter(fitsBounds)
  return {
    workspaces,
    truncated:
      truncated === true ||
      (totalCount ?? worktrees.length) > worktreeRows.length ||
      projectFolders.length > room ||
      workspaces.length < candidates.length,
    ...(statuses
      ? { statusTruncated: statuses.truncated && workspaces.some((row) => !('status' in row)) }
      : {})
  }
}

/** `project.list`: the repositories and folders `repo.list` shows, which hides retired rows. */
export async function listPluginProjects(
  call: PluginRuntimeRpc
): Promise<PluginHostResult<'project.list'>> {
  const { repos } = projectListAnswer.parse(await call('repo.list', {}))
  const candidates = repos.slice(0, PLUGIN_PROJECT_LIST_LIMIT).map((repo) => ({
    id: repo.id,
    name: (repo.displayName ?? '').slice(0, 512),
    kind: repo.kind === 'folder' ? ('folder' as const) : ('git' as const),
    hostId: pluginHostId(repo),
    path: repo.path
  }))
  const projects = candidates.filter((project) => project.id.length > 0 && fitsBounds(project))
  return {
    projects,
    truncated: repos.length > PLUGIN_PROJECT_LIST_LIMIT || projects.length < candidates.length
  }
}
