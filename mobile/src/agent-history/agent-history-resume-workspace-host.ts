import {
  getRepoExecutionHostId,
  normalizeExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../src/shared/execution-host'
import { isPathInsideOrEqual } from '../../../src/shared/cross-platform-path'
import type { Worktree } from '../worktree/workspace-list-types'

// Which execution host a mobile resume target workspace runs on.

export type MobileAiVaultResumeTargetStatus = 'local' | 'ssh' | 'runtime' | 'unknown'

export type MobileAiVaultResumeRepo = {
  id: string
  path?: string | null
  projectGroupId?: string | null
  connectionId?: string | null
  executionHostId?: ExecutionHostId | null
}

export type MobileAiVaultResumeWorktree = Pick<Worktree, 'repoId' | 'worktreeId'> & {
  path?: string | null
  workspaceKind?: Worktree['workspaceKind']
  hostId?: ExecutionHostId | null
}

export type MobileAiVaultResumeFolderWorkspace = {
  id: string
  projectGroupId: string
  folderPath: string
  connectionId?: string | null
}

export type MobileAiVaultResumeProjectGroup = {
  id: string
  parentGroupId?: string | null
  connectionId?: string | null
  executionHostId?: ExecutionHostId | string | null
}

function getMobileAiVaultResumeRepoTargetStatus(
  repo: MobileAiVaultResumeRepo | null | undefined
): MobileAiVaultResumeTargetStatus {
  if (!repo) {
    return 'unknown'
  }
  return getMobileAiVaultResumeExecutionHostTargetStatus(getRepoExecutionHostId(repo))
}

export function getMobileAiVaultResumeWorktreeTargetStatus(args: {
  worktreeId: string | null
  worktrees: readonly MobileAiVaultResumeWorktree[]
  repos: readonly MobileAiVaultResumeRepo[]
  folderWorkspaces?: readonly MobileAiVaultResumeFolderWorkspace[]
  projectGroups?: readonly MobileAiVaultResumeProjectGroup[]
}): MobileAiVaultResumeTargetStatus {
  if (!args.worktreeId) {
    return 'unknown'
  }
  const worktree = args.worktrees.find((candidate) => candidate.worktreeId === args.worktreeId)
  if (!worktree) {
    return 'unknown'
  }
  if (worktree.workspaceKind === 'folder-workspace') {
    return getMobileAiVaultResumeFolderTargetStatus({
      worktreeId: args.worktreeId,
      worktree,
      repos: args.repos,
      folderWorkspaces: args.folderWorkspaces ?? [],
      projectGroups: args.projectGroups ?? []
    })
  }
  const worktreeHost = getMobileAiVaultResumeExecutionHostTargetStatus(worktree.hostId)
  if (worktreeHost !== 'unknown') {
    return worktreeHost
  }
  return getMobileAiVaultResumeRepoTargetStatus(
    args.repos.find((candidate) => candidate.id === worktree.repoId)
  )
}

/** The SSH workspace's own host, so a resume only targets the host holding the transcript. */
export function getMobileAiVaultResumeWorktreeExecutionHostId(args: {
  worktreeId: string
  worktrees: readonly MobileAiVaultResumeWorktree[]
  repos: readonly MobileAiVaultResumeRepo[]
  folderWorkspaces: readonly MobileAiVaultResumeFolderWorkspace[]
  projectGroups: readonly MobileAiVaultResumeProjectGroup[]
}): ExecutionHostId | null {
  const worktree = args.worktrees.find((candidate) => candidate.worktreeId === args.worktreeId)
  if (!worktree) {
    return null
  }
  if (worktree.workspaceKind !== 'folder-workspace') {
    const repo = args.repos.find((candidate) => candidate.id === worktree.repoId)
    return normalizeExecutionHostId(worktree.hostId) ?? (repo ? getRepoExecutionHostId(repo) : null)
  }
  const folderWorkspace = args.worktreeId.startsWith('folder:')
    ? args.folderWorkspaces.find(
        (workspace) => workspace.id === args.worktreeId.slice('folder:'.length)
      )
    : undefined
  if (!folderWorkspace) {
    return null
  }
  const projectGroupId =
    folderWorkspace.projectGroupId ?? parseFolderWorkspaceRepoId(worktree.repoId)
  const projectGroup = projectGroupId
    ? args.projectGroups.find((group) => group.id === projectGroupId)
    : null
  const groupHostId = normalizeExecutionHostId(projectGroup?.executionHostId)
  if (groupHostId) {
    return groupHostId
  }
  const explicitConnectionId = (
    folderWorkspace.connectionId ??
    projectGroup?.connectionId ??
    ''
  ).trim()
  if (explicitConnectionId) {
    return toSshExecutionHostId(explicitConnectionId)
  }
  const hostIds = new Set(
    getMobileFolderWorkspaceCandidateRepos({
      folderWorkspace,
      projectGroupId,
      projectGroups: args.projectGroups,
      repos: args.repos
    }).map(getRepoExecutionHostId)
  )
  return hostIds.size === 1 ? ([...hostIds][0] ?? null) : null
}

function getMobileAiVaultResumeFolderTargetStatus(args: {
  worktreeId: string
  worktree: MobileAiVaultResumeWorktree
  repos: readonly MobileAiVaultResumeRepo[]
  folderWorkspaces: readonly MobileAiVaultResumeFolderWorkspace[]
  projectGroups: readonly MobileAiVaultResumeProjectGroup[]
}): MobileAiVaultResumeTargetStatus {
  const folderWorkspaceId = args.worktreeId.startsWith('folder:')
    ? args.worktreeId.slice('folder:'.length)
    : null
  const folderWorkspace = folderWorkspaceId
    ? args.folderWorkspaces.find((workspace) => workspace.id === folderWorkspaceId)
    : null
  if (!folderWorkspace) {
    return 'unknown'
  }
  const projectGroupId =
    folderWorkspace.projectGroupId ?? parseFolderWorkspaceRepoId(args.worktree.repoId)
  const projectGroup = projectGroupId
    ? args.projectGroups.find((group) => group.id === projectGroupId)
    : null

  const groupHostId = normalizeExecutionHostId(projectGroup?.executionHostId)
  if (groupHostId) {
    return getMobileAiVaultResumeExecutionHostTargetStatus(groupHostId)
  }

  const explicitConnectionId = (
    folderWorkspace?.connectionId ??
    projectGroup?.connectionId ??
    ''
  ).trim()
  if (explicitConnectionId) {
    return getMobileAiVaultResumeExecutionHostTargetStatus(
      toSshExecutionHostId(explicitConnectionId)
    )
  }

  return mergeMobileAiVaultResumeExecutionHostTargetStatuses(
    getMobileFolderWorkspaceCandidateRepos({
      folderWorkspace,
      projectGroupId,
      projectGroups: args.projectGroups,
      repos: args.repos
    }).map(getRepoExecutionHostId)
  )
}

function getMobileAiVaultResumeExecutionHostTargetStatus(
  hostId: ExecutionHostId | null | undefined
): MobileAiVaultResumeTargetStatus {
  const parsed = parseExecutionHostId(hostId)
  if (!parsed) {
    return 'unknown'
  }
  return parsed.kind
}

function parseFolderWorkspaceRepoId(repoId: string): string | null {
  const prefix = 'folder-workspace:'
  return repoId.startsWith(prefix) ? repoId.slice(prefix.length) || null : null
}

function getMobileFolderWorkspaceCandidateRepos(args: {
  folderWorkspace: MobileAiVaultResumeFolderWorkspace | null | undefined
  projectGroupId: string | null
  projectGroups: readonly MobileAiVaultResumeProjectGroup[]
  repos: readonly MobileAiVaultResumeRepo[]
}): MobileAiVaultResumeRepo[] {
  if (!args.folderWorkspace || !args.projectGroupId) {
    return []
  }
  const folderWorkspace = args.folderWorkspace
  const groupIds = getMobileProjectGroupSubtreeIds(args.projectGroups, args.projectGroupId)
  const groupRepos = args.repos.filter(
    (repo) => typeof repo.projectGroupId === 'string' && groupIds.has(repo.projectGroupId)
  )
  const pathRepos = args.repos.filter(
    (repo) =>
      !(typeof repo.projectGroupId === 'string' && groupIds.has(repo.projectGroupId)) &&
      typeof repo.path === 'string' &&
      repo.path.trim().length > 0 &&
      isPathInsideOrEqual(folderWorkspace.folderPath, repo.path)
  )
  if (folderWorkspace.connectionId) {
    return [
      ...groupRepos,
      ...pathRepos.filter((repo) => (repo.connectionId ?? null) === folderWorkspace.connectionId)
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

function getMobileProjectGroupSubtreeIds(
  projectGroups: readonly MobileAiVaultResumeProjectGroup[],
  projectGroupId: string
): Set<string> {
  const ids = new Set<string>([projectGroupId])
  let changed = true
  while (changed) {
    changed = false
    for (const group of projectGroups) {
      if (group.parentGroupId && ids.has(group.parentGroupId) && !ids.has(group.id)) {
        ids.add(group.id)
        changed = true
      }
    }
  }
  return ids
}

function mergeMobileAiVaultResumeExecutionHostTargetStatuses(
  hostIds: readonly ExecutionHostId[]
): MobileAiVaultResumeTargetStatus {
  if (hostIds.length === 0) {
    return 'local'
  }
  const statuses = hostIds.map(getMobileAiVaultResumeExecutionHostTargetStatus)
  const uniqueStatuses = new Set(statuses)
  if (uniqueStatuses.has('runtime')) {
    return 'runtime'
  }
  return new Set(hostIds).size === 1 ? (statuses[0] ?? 'unknown') : 'unknown'
}
