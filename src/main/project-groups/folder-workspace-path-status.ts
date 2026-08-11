import { stat as statLocalPath } from 'node:fs/promises'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import type {
  FolderWorkspacePathStatus,
  FolderWorkspacePathStatusRequest
} from '../../shared/folder-workspace-path-status'
import { getProjectGroupSubtreeIds } from '../../shared/project-groups'
import type { FolderWorkspace, ProjectGroup, Repo } from '../../shared/types'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  toSshExecutionHostId
} from '../../shared/execution-host'
import type { IFilesystemProvider } from '../providers/types'
import {
  resolveDeclaredFolderScopeOwner,
  resolveFolderWorkspaceDirectAuthority,
  resolveProjectGroupDirectAuthority
} from '../../shared/folder-workspace-owner-resolution'
import {
  findFolderWorkspacePathStatusScope,
  findProjectGroupPathStatusScope
} from './folder-workspace-path-status-scope'

type FolderWorkspacePathStatusStore = {
  getRepos: () => Repo[]
  getProjectGroups?: () => ProjectGroup[]
  getFolderWorkspaces?: () => FolderWorkspace[]
}

export type FolderWorkspacePathConnectionResolution =
  | { kind: 'local' }
  | { kind: 'ssh'; connectionId: string }
  | { kind: 'ambiguous' }

type FolderWorkspacePathStatusDeps = {
  getSshFilesystemProvider: (connectionId: string) => IFilesystemProvider | undefined
}

type ResolvedFolderWorkspaceStatusPath = {
  folderPath: string
  projectGroupId: string | null
  connectionId?: string | null
  connectionIdIsAuthoritative?: boolean
  authorityIsInvalid?: boolean
}

function getKnownFolderPathExecutionHostId(args: {
  connectionId?: string | null
  connectionIdIsAuthoritative?: boolean
}) {
  return args.connectionId
    ? toSshExecutionHostId(args.connectionId)
    : args.connectionIdIsAuthoritative
      ? LOCAL_EXECUTION_HOST_ID
      : null
}

function getFolderScopeCandidateRepos(args: {
  folderPath: string
  projectGroupId?: string | null
  connectionId?: string | null
  projectGroups: readonly ProjectGroup[]
  repos: readonly Repo[]
}): Repo[] {
  const executionHostId = getKnownFolderPathExecutionHostId(args)
  const projectGroups = executionHostId
    ? args.projectGroups.filter((group) => {
        const owner = resolveDeclaredFolderScopeOwner(group)
        return owner.status === 'owned' && owner.executionHostId === executionHostId
      })
    : args.projectGroups
  const repos = executionHostId
    ? args.repos.filter((repo) => getRepoExecutionHostId(repo) === executionHostId)
    : args.repos
  const groupIds = args.projectGroupId
    ? getProjectGroupSubtreeIds(projectGroups, args.projectGroupId)
    : null
  const groupRepos = groupIds
    ? repos.filter(
        (repo) => typeof repo.projectGroupId === 'string' && groupIds.has(repo.projectGroupId)
      )
    : []
  const pathRepos = repos.filter(
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
  connectionIdIsAuthoritative?: boolean
  authorityIsInvalid?: boolean
  projectGroups: readonly ProjectGroup[]
  repos: readonly Repo[]
}): FolderWorkspacePathConnectionResolution {
  if (args.authorityIsInvalid) {
    return { kind: 'ambiguous' }
  }
  if (args.connectionIdIsAuthoritative && !args.connectionId) {
    return { kind: 'local' }
  }
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

export async function getFolderWorkspacePathStatusForPath(
  args: {
    folderPath: string
    projectGroupId?: string | null
    connectionId?: string | null
    connectionIdIsAuthoritative?: boolean
    authorityIsInvalid?: boolean
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
  request: FolderWorkspacePathStatusRequest
}): ResolvedFolderWorkspaceStatusPath {
  const { request } = args
  if (request.scope === 'project-group') {
    const group = findProjectGroupPathStatusScope({
      groups: args.store.getProjectGroups?.() ?? [],
      projectGroupId: request.projectGroupId,
      executionHostId: request.executionHostId
    })
    if (!group?.parentPath) {
      throw new Error('folder_workspace_path_scope_not_found')
    }
    const authority = resolveProjectGroupDirectAuthority(group)
    return {
      folderPath: group.parentPath,
      projectGroupId: group.id,
      connectionId: authority.status === 'direct' ? authority.connectionId : undefined,
      connectionIdIsAuthoritative: authority.status === 'direct',
      authorityIsInvalid: authority.status === 'invalid'
    }
  }

  if (request.scope === 'path') {
    return {
      folderPath: request.path,
      projectGroupId: null,
      connectionId: request.connectionId ?? null,
      connectionIdIsAuthoritative: 'connectionId' in request
    }
  }

  const projectGroups = args.store.getProjectGroups?.() ?? []
  const workspace = findFolderWorkspacePathStatusScope({
    workspaces: args.store.getFolderWorkspaces?.() ?? [],
    groups: projectGroups,
    folderWorkspaceId: request.folderWorkspaceId,
    executionHostId: request.executionHostId
  })
  if (!workspace) {
    throw new Error('folder_workspace_path_scope_not_found')
  }
  return resolveFolderWorkspaceStatusPathForWorkspace(args.store, workspace)
}

function resolveFolderWorkspaceStatusPathForWorkspace(
  store: FolderWorkspacePathStatusStore,
  workspace: FolderWorkspace
): ResolvedFolderWorkspaceStatusPath {
  const groups = (store.getProjectGroups?.() ?? []).filter(
    (entry) => entry.id === workspace.projectGroupId
  )
  const authority = resolveFolderWorkspaceDirectAuthority(workspace, groups)
  return {
    folderPath: workspace.folderPath,
    projectGroupId: workspace.projectGroupId,
    connectionId: authority.status === 'direct' ? authority.connectionId : undefined,
    connectionIdIsAuthoritative: authority.status === 'direct',
    authorityIsInvalid: authority.status === 'invalid'
  }
}

export async function getFolderWorkspacePathStatusForWorkspace(
  store: FolderWorkspacePathStatusStore,
  workspace: FolderWorkspace,
  deps: FolderWorkspacePathStatusDeps
): Promise<FolderWorkspacePathStatus> {
  const scope = resolveFolderWorkspaceStatusPathForWorkspace(store, workspace)
  return getFolderWorkspacePathStatusForPath(
    {
      ...scope,
      projectGroups: store.getProjectGroups?.() ?? [],
      repos: store.getRepos()
    },
    deps
  )
}

export async function getFolderWorkspacePathStatus(
  store: FolderWorkspacePathStatusStore,
  request: FolderWorkspacePathStatusRequest,
  deps: FolderWorkspacePathStatusDeps
): Promise<FolderWorkspacePathStatus> {
  const scope = resolveFolderWorkspaceStatusPath({ store, request })
  return getFolderWorkspacePathStatusForPath(
    {
      folderPath: scope.folderPath,
      projectGroupId: scope.projectGroupId,
      connectionId: scope.connectionId,
      connectionIdIsAuthoritative: scope.connectionIdIsAuthoritative,
      authorityIsInvalid: scope.authorityIsInvalid,
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
