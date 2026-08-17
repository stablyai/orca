import { stat as statLocalPath } from 'node:fs/promises'
import { isPathInsideOrEqual } from '../../shared/cross-platform-path'
import type { FolderWorkspacePathStatus } from '../../shared/folder-workspace-path-status'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import {
  buildProjectGroupOwnerIndex,
  getFolderWorkspaceProjectGroupOwnerHostId,
  getProjectGroupOwnerHostId,
  getProjectGroupSubtreeIds,
  resolveFolderWorkspaceProjectGroup,
  resolveProjectGroupOwner
} from '../../shared/project-groups'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { Repo } from '../../shared/repo-types'
import {
  type OwnerQualifiedFolderWorkspacePathStatusRequest,
  resolveFolderWorkspaceCatalogOwnerHostIdFromIndex,
  resolveLegacySshFolderWorkspaceProjectGroup
} from '../../shared/folder-workspaces'
import type { IFilesystemProvider } from '../providers/types'

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
  request: OwnerQualifiedFolderWorkspacePathStatusRequest
}): {
  folderPath: string
  projectGroupId: string | null
  connectionId?: string | null
  ownerHostId?: ExecutionHostId
} {
  const { request } = args
  const projectGroups = args.store.getProjectGroups?.() ?? []
  const projectGroupIndex = buildProjectGroupOwnerIndex(projectGroups)
  if (request.scope === 'project-group') {
    const group = resolveProjectGroupOwner(
      projectGroupIndex,
      request.projectGroupId,
      request.ownerHostId
    )
    if (!group?.parentPath) {
      throw new Error('folder_workspace_path_scope_not_found')
    }
    return {
      folderPath: group.parentPath,
      projectGroupId: group.id,
      connectionId: group.connectionId ?? null,
      ownerHostId: getProjectGroupOwnerHostId(group)
    }
  }

  if (request.scope === 'path') {
    return {
      folderPath: request.path,
      projectGroupId: null,
      connectionId: request.connectionId ?? null
    }
  }

  const matches = (args.store.getFolderWorkspaces?.() ?? []).filter(
    (entry) =>
      entry.id === request.folderWorkspaceId &&
      (!request.ownerHostId ||
        resolveFolderWorkspaceCatalogOwnerHostIdFromIndex(entry, projectGroupIndex) ===
          request.ownerHostId)
  )
  const workspace = matches.length === 1 ? matches[0] : null
  if (!workspace) {
    throw new Error('folder_workspace_path_scope_not_found')
  }
  const group =
    resolveFolderWorkspaceProjectGroup(projectGroupIndex, workspace) ??
    resolveLegacySshFolderWorkspaceProjectGroup(projectGroupIndex, workspace)
  if (!group && projectGroupIndex.byId.has(workspace.projectGroupId)) {
    throw new Error('folder_workspace_path_scope_not_found')
  }
  const ownerHostId = getFolderWorkspaceProjectGroupOwnerHostId(workspace, projectGroupIndex)
  return {
    folderPath: workspace.folderPath,
    projectGroupId: workspace.projectGroupId,
    connectionId: workspace.connectionId ?? group?.connectionId ?? null,
    ownerHostId
  }
}

export async function getFolderWorkspacePathStatus(
  store: FolderWorkspacePathStatusStore,
  request: OwnerQualifiedFolderWorkspacePathStatusRequest,
  deps: FolderWorkspacePathStatusDeps
): Promise<FolderWorkspacePathStatus> {
  const scope = resolveFolderWorkspaceStatusPath({ store, request })
  const projectGroups = store.getProjectGroups?.() ?? []
  return getFolderWorkspacePathStatusForPath(
    {
      folderPath: scope.folderPath,
      projectGroupId: scope.projectGroupId,
      connectionId: scope.connectionId,
      projectGroups: scope.ownerHostId
        ? projectGroups.filter((group) => getProjectGroupOwnerHostId(group) === scope.ownerHostId)
        : projectGroups,
      repos: scope.ownerHostId
        ? store.getRepos().filter((repo) => getRepoExecutionHostId(repo) === scope.ownerHostId)
        : store.getRepos()
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
