import {
  getRepoExecutionHostId,
  normalizeExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../src/shared/execution-host'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import { isPathInsideOrEqual } from '../../../src/shared/cross-platform-path'
import type { Worktree } from '../worktree/workspace-list-types'
import {
  canResumeInMobileSessionWorktree,
  resolveMobileAgentHistorySessionWorktree
} from './agent-history-session-worktree'

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

export type MobileAiVaultSessionResumeTarget =
  | {
      status: 'ready'
      worktreeId: string
      targetStatus: 'local'
      workspacePath: string | null
      terminalPlatform: NodeJS.Platform | null
    }
  | { status: 'blocked'; message: string }

export function getMobileAiVaultResumeRepoTargetStatus(
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

export function isSupportedMobileAiVaultResumeTargetStatus(
  status: MobileAiVaultResumeTargetStatus
): status is 'local' {
  // Why: mobile sessions come from the host-local transcript scan, so an SSH
  // workspace cannot see the transcript file (mirror of desktop #6270).
  return status === 'local'
}

export function mobileAiVaultResumeTargetBlockMessage(
  status: MobileAiVaultResumeTargetStatus
): string {
  if (status === 'runtime') {
    return 'Resume from history is not available in runtime-hosted workspaces.'
  }
  if (status === 'ssh') {
    return 'This session is stored on the host machine, so it cannot be resumed in an SSH workspace. Open a local workspace for this project.'
  }
  return 'Open a local workspace before resuming a session.'
}

export function resolveMobileAiVaultSessionResumeTarget(args: {
  session: AiVaultSession
  activeWorktreeId: string | null
  worktrees: readonly Worktree[]
  repos: readonly MobileAiVaultResumeRepo[]
  folderWorkspaces?: readonly MobileAiVaultResumeFolderWorkspace[]
  projectGroups?: readonly MobileAiVaultResumeProjectGroup[]
}): MobileAiVaultSessionResumeTarget {
  const sessionWorktree = resolveMobileAgentHistorySessionWorktree({
    session: args.session,
    worktrees: args.worktrees,
    activeWorktreeId: args.activeWorktreeId
  })
  const sessionWorktreeId = canResumeInMobileSessionWorktree(sessionWorktree)
    ? sessionWorktree?.worktreeId
    : null
  const candidateWorktreeIds = [
    sessionWorktreeId,
    args.activeWorktreeId && args.activeWorktreeId !== sessionWorktreeId
      ? args.activeWorktreeId
      : null
  ].filter((candidate): candidate is string => Boolean(candidate))

  for (const candidateWorktreeId of candidateWorktreeIds) {
    const targetStatus = getMobileAiVaultResumeWorktreeTargetStatus({
      worktreeId: candidateWorktreeId,
      worktrees: args.worktrees,
      repos: args.repos,
      folderWorkspaces: args.folderWorkspaces,
      projectGroups: args.projectGroups
    })
    if (!isSupportedMobileAiVaultResumeTargetStatus(targetStatus)) {
      continue
    }
    return {
      status: 'ready',
      worktreeId: candidateWorktreeId,
      targetStatus,
      workspacePath:
        args.worktrees.find((worktree) => worktree.worktreeId === candidateWorktreeId)?.path ??
        null,
      terminalPlatform:
        args.worktrees.find((worktree) => worktree.worktreeId === candidateWorktreeId)
          ?.terminalPlatform ?? null
    }
  }

  const blockedStatus = getMobileAiVaultResumeWorktreeTargetStatus({
    worktreeId: candidateWorktreeIds[0] ?? args.activeWorktreeId,
    worktrees: args.worktrees,
    repos: args.repos,
    folderWorkspaces: args.folderWorkspaces,
    projectGroups: args.projectGroups
  })
  return { status: 'blocked', message: mobileAiVaultResumeTargetBlockMessage(blockedStatus) }
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
