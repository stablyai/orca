import { stat as statLocalPath } from 'node:fs/promises'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import type {
  FolderWorkspacePathStatus,
  FolderWorkspacePathStatusRequest
} from '../../shared/folder-workspace-path-status'
import { getProjectGroupSubtreeIds } from '../../shared/project-groups'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import type { IFilesystemProvider } from '../providers/types'
import type { Store } from '../persistence'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { getLocalProjectWorktreeGitOptions } from '../project-runtime-git-options'
import { getLocalWorktreePathAccess } from '../local-worktree-filesystem'

type FolderWorkspacePathStatusStore = {
  getRepos: () => Repo[]
  getProjectGroups?: () => ProjectGroup[]
  getFolderWorkspaces?: () => FolderWorkspace[]
  getProjects?: Store['getProjects']
  getSettings?: Store['getSettings']
}

export type FolderWorkspacePathConnectionResolution =
  | { kind: 'local' }
  | { kind: 'ssh'; connectionId: string }
  | { kind: 'ambiguous' }

type FolderWorkspacePathStatusDeps = {
  getSshFilesystemProvider: (connectionId: string) => IFilesystemProvider | undefined
}

function getFolderScopeCandidateRepos(args: {
  folderPath: string
  projectGroupId?: string | null
  connectionId?: string | null
  projectGroups: readonly ProjectGroup[]
  repos: readonly Repo[]
}): Repo[] {
  const groupIds = args.projectGroupId
    ? getProjectGroupSubtreeIds(args.projectGroups, args.projectGroupId)
    : null
  const groupRepos = groupIds
    ? args.repos.filter(
        (repo) => typeof repo.projectGroupId === 'string' && groupIds.has(repo.projectGroupId)
      )
    : []
  const pathRepos = args.repos.filter(
    (repo) =>
      !(groupIds && typeof repo.projectGroupId === 'string' && groupIds.has(repo.projectGroupId)) &&
      isPathInsideOrEqual(args.folderPath, repo.path)
  )
  if (args.connectionId) {
    return [
      ...groupRepos,
      ...pathRepos.filter((repo) => (repo.connectionId ?? null) === args.connectionId)
    ]
  }
  if (groupRepos.length === 0) {
    return pathRepos
  }
  const groupConnectionIds = new Set(groupRepos.map((repo) => repo.connectionId ?? null))
  return [
    ...groupRepos,
    ...pathRepos.filter((repo) => groupConnectionIds.has(repo.connectionId ?? null))
  ]
}

export function inferFolderWorkspacePathConnection(args: {
  folderPath: string
  projectGroupId?: string | null
  connectionId?: string | null
  projectGroups: readonly ProjectGroup[]
  repos: readonly Repo[]
}): FolderWorkspacePathConnectionResolution {
  const candidateRepos = getFolderScopeCandidateRepos(args)
  let hasLocalRepo = false
  const connectionIds = new Set<string>()
  for (const repo of candidateRepos) {
    if (repo.connectionId) {
      connectionIds.add(repo.connectionId)
    } else {
      hasLocalRepo = true
    }
  }
  if (args.connectionId) {
    const hasDifferentSshConnection = [...connectionIds].some(
      (connectionId) => connectionId !== args.connectionId
    )
    if (hasLocalRepo || hasDifferentSshConnection) {
      return { kind: 'ambiguous' }
    }
    return { kind: 'ssh', connectionId: args.connectionId }
  }
  if (hasLocalRepo && connectionIds.size > 0) {
    return { kind: 'ambiguous' }
  }
  if (connectionIds.size === 0) {
    return { kind: 'local' }
  }
  if (connectionIds.size === 1) {
    return { kind: 'ssh', connectionId: [...connectionIds][0] }
  }
  return { kind: 'ambiguous' }
}

function pathStatErrorReason(error: unknown): 'missing' | 'unavailable' {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unavailable'
}

async function statFolderPath(
  path: string,
  connection: FolderWorkspacePathConnectionResolution,
  deps: FolderWorkspacePathStatusDeps
): Promise<FolderWorkspacePathStatus> {
  if (connection.kind === 'ambiguous') {
    return { path, exists: false, reason: 'ambiguous-connection' }
  }
  if (connection.kind === 'ssh') {
    const provider = deps.getSshFilesystemProvider(connection.connectionId)
    if (!provider) {
      return { path, exists: false, reason: 'unavailable' }
    }
    try {
      const stats = await provider.stat(path)
      return stats.type === 'directory'
        ? { path, exists: true }
        : { path, exists: false, reason: 'not-directory' }
    } catch (error) {
      return { path, exists: false, reason: pathStatErrorReason(error) }
    }
  }

  try {
    const stats = await statLocalPath(path)
    return stats.isDirectory()
      ? { path, exists: true }
      : { path, exists: false, reason: 'not-directory' }
  } catch (error) {
    return { path, exists: false, reason: pathStatErrorReason(error) }
  }
}

async function statRepoPath(
  store: FolderWorkspacePathStatusStore,
  request: Extract<FolderWorkspacePathStatusRequest, { scope: 'repo' }>,
  deps: FolderWorkspacePathStatusDeps
): Promise<FolderWorkspacePathStatus> {
  const repo = store
    .getRepos()
    .find(
      (candidate) =>
        candidate.id === request.repoId &&
        getRepoExecutionHostId(candidate) === request.executionHostId
    )
  if (!repo) {
    throw new Error('folder_workspace_path_scope_not_found')
  }
  if (repo.connectionId) {
    return statFolderPath(repo.path, { kind: 'ssh', connectionId: repo.connectionId }, deps)
  }
  let wslDistro: string | undefined
  try {
    wslDistro = getLocalProjectWorktreeGitOptions(store, repo).wslDistro
  } catch {
    return { path: repo.path, exists: false, reason: 'unavailable' }
  }
  if (!wslDistro) {
    return statFolderPath(repo.path, { kind: 'local' }, deps)
  }
  try {
    const stats = await getLocalWorktreePathAccess({ wslDistro }).statPath(repo.path)
    const type = (stats as { type?: unknown } | null)?.type
    return type === 'directory'
      ? { path: repo.path, exists: true }
      : { path: repo.path, exists: false, reason: 'not-directory' }
  } catch (error) {
    return { path: repo.path, exists: false, reason: pathStatErrorReason(error) }
  }
}

export async function getFolderWorkspacePathStatusForPath(
  args: {
    folderPath: string
    projectGroupId?: string | null
    connectionId?: string | null
    projectGroups: readonly ProjectGroup[]
    repos: readonly Repo[]
  },
  deps: FolderWorkspacePathStatusDeps
): Promise<FolderWorkspacePathStatus> {
  const connection = inferFolderWorkspacePathConnection(args)
  return statFolderPath(args.folderPath, connection, deps)
}

export function resolveFolderWorkspaceStatusPath(args: {
  store: FolderWorkspacePathStatusStore
  request: Exclude<FolderWorkspacePathStatusRequest, { scope: 'repo' }>
}): { folderPath: string; projectGroupId: string | null; connectionId?: string | null } {
  const { request } = args
  if (request.scope === 'project-group') {
    const group = args.store
      .getProjectGroups?.()
      .find((entry) => entry.id === request.projectGroupId)
    if (!group?.parentPath) {
      throw new Error('folder_workspace_path_scope_not_found')
    }
    return {
      folderPath: group.parentPath,
      projectGroupId: group.id,
      connectionId: group.connectionId ?? null
    }
  }

  if (request.scope === 'path') {
    return {
      folderPath: request.path,
      projectGroupId: null,
      connectionId: request.connectionId ?? null
    }
  }

  const workspace = args.store
    .getFolderWorkspaces?.()
    .find((entry) => entry.id === request.folderWorkspaceId)
  if (!workspace) {
    throw new Error('folder_workspace_path_scope_not_found')
  }
  const group = args.store
    .getProjectGroups?.()
    .find((entry) => entry.id === workspace.projectGroupId)
  return {
    folderPath: workspace.folderPath,
    projectGroupId: workspace.projectGroupId,
    connectionId: workspace.connectionId ?? group?.connectionId ?? null
  }
}

export async function getFolderWorkspacePathStatus(
  store: FolderWorkspacePathStatusStore,
  request: FolderWorkspacePathStatusRequest,
  deps: FolderWorkspacePathStatusDeps
): Promise<FolderWorkspacePathStatus> {
  if (request.scope === 'repo') {
    return statRepoPath(store, request, deps)
  }
  const scope = resolveFolderWorkspaceStatusPath({ store, request })
  return getFolderWorkspacePathStatusForPath(
    {
      folderPath: scope.folderPath,
      projectGroupId: scope.projectGroupId,
      connectionId: scope.connectionId,
      projectGroups: store.getProjectGroups?.() ?? [],
      repos: store.getRepos()
    },
    deps
  )
}

export function assertFolderWorkspacePathUsable(status: FolderWorkspacePathStatus): void {
  if (status.exists) {
    return
  }
  if (status.reason === 'missing') {
    throw new Error(`folder_workspace_path_missing:${status.path}`)
  }
  if (status.reason === 'not-directory') {
    throw new Error(`folder_workspace_path_not_directory:${status.path}`)
  }
  if (status.reason === 'ambiguous-connection') {
    throw new Error(`folder_workspace_connection_ambiguous:${status.path}`)
  }
  throw new Error(`folder_workspace_path_unavailable:${status.path}`)
}
