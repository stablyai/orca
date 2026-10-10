import {
  getRepoExecutionHostId,
  normalizeExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../src/shared/execution-host'
import { isPathInsideOrEqual } from '../../../src/shared/cross-platform-path'
import type { Worktree } from '../worktree/workspace-list-types'

export type MobileAiVaultResumeTargetStatus = 'local' | 'ssh' | 'runtime' | 'unknown'

export type MobileAiVaultResumeRepo = {
  id: string
  path?: string | null
  projectGroupId?: string | null
  connectionId?: string | null
  executionHostId?: ExecutionHostId | null
}

type MobileAiVaultResumeWorktree = Pick<Worktree, 'repoId' | 'worktreeId'> & {
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

export type MobileAiVaultResumeWorkspaceTarget = {
  status: MobileAiVaultResumeTargetStatus
  hostId: ExecutionHostId | null
}

export const UNKNOWN_RESUME_WORKSPACE_TARGET: MobileAiVaultResumeWorkspaceTarget = {
  status: 'unknown',
  hostId: null
}

export function resumeWorkspaceTargetForHost(
  hostId: ExecutionHostId | null | undefined
): MobileAiVaultResumeWorkspaceTarget {
  const status = getMobileAiVaultResumeExecutionHostTargetStatus(hostId)
  return status === 'unknown'
    ? UNKNOWN_RESUME_WORKSPACE_TARGET
    : { status, hostId: normalizeExecutionHostId(hostId) }
}

export function getMobileAiVaultResumeWorktreeTarget(args: {
  worktreeId: string | null
  worktrees: readonly MobileAiVaultResumeWorktree[]
  repos: readonly MobileAiVaultResumeRepo[]
  folderWorkspaces?: readonly MobileAiVaultResumeFolderWorkspace[]
  projectGroups?: readonly MobileAiVaultResumeProjectGroup[]
}): MobileAiVaultResumeWorkspaceTarget {
  if (!args.worktreeId) {
    return UNKNOWN_RESUME_WORKSPACE_TARGET
  }
  const worktree = args.worktrees.find((candidate) => candidate.worktreeId === args.worktreeId)
  if (!worktree) {
    return UNKNOWN_RESUME_WORKSPACE_TARGET
  }
  if (worktree.workspaceKind === 'folder-workspace') {
    return getMobileAiVaultResumeFolderTarget({
      worktreeId: args.worktreeId,
      worktree,
      repos: args.repos,
      folderWorkspaces: args.folderWorkspaces ?? [],
      projectGroups: args.projectGroups ?? []
    })
  }
  const worktreeTarget = resumeWorkspaceTargetForHost(worktree.hostId)
  if (worktreeTarget.status !== 'unknown') {
    return worktreeTarget
  }
  const repo = args.repos.find((candidate) => candidate.id === worktree.repoId)
  return repo ? resumeWorkspaceTargetForHost(getRepoExecutionHostId(repo)) : worktreeTarget
}

function getMobileAiVaultResumeFolderTarget(args: {
  worktreeId: string
  worktree: MobileAiVaultResumeWorktree
  repos: readonly MobileAiVaultResumeRepo[]
  folderWorkspaces: readonly MobileAiVaultResumeFolderWorkspace[]
  projectGroups: readonly MobileAiVaultResumeProjectGroup[]
}): MobileAiVaultResumeWorkspaceTarget {
  const folderWorkspaceId = args.worktreeId.startsWith('folder:')
    ? args.worktreeId.slice('folder:'.length)
    : null
  const folderWorkspace = folderWorkspaceId
    ? args.folderWorkspaces.find((workspace) => workspace.id === folderWorkspaceId)
    : null
  if (!folderWorkspace) {
    return UNKNOWN_RESUME_WORKSPACE_TARGET
  }
  const projectGroupId =
    folderWorkspace.projectGroupId ?? parseFolderWorkspaceRepoId(args.worktree.repoId)
  const projectGroup = projectGroupId
    ? args.projectGroups.find((group) => group.id === projectGroupId)
    : null

  const groupHostId = normalizeExecutionHostId(projectGroup?.executionHostId)
  if (groupHostId) {
    return resumeWorkspaceTargetForHost(groupHostId)
  }

  const explicitConnectionId = (
    folderWorkspace?.connectionId ??
    projectGroup?.connectionId ??
    ''
  ).trim()
  if (explicitConnectionId) {
    return resumeWorkspaceTargetForHost(toSshExecutionHostId(explicitConnectionId))
  }

  return mergeMobileAiVaultResumeExecutionHostTargets(
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

function mergeMobileAiVaultResumeExecutionHostTargets(
  hostIds: readonly ExecutionHostId[]
): MobileAiVaultResumeWorkspaceTarget {
  if (hostIds.length === 0) {
    return { status: 'local', hostId: null }
  }
  const statuses = hostIds.map(getMobileAiVaultResumeExecutionHostTargetStatus)
  if (statuses.includes('runtime')) {
    return { status: 'runtime', hostId: null }
  }
  return new Set(hostIds).size === 1
    ? resumeWorkspaceTargetForHost(hostIds[0])
    : UNKNOWN_RESUME_WORKSPACE_TARGET
}
