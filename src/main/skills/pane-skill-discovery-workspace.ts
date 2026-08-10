import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../shared/execution-host'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import type {
  FolderWorkspace,
  ProjectGroup,
  Repo,
  WorktreeMeta,
  WorkspaceSessionState
} from '../../shared/types'
import { splitWorktreeIdForFilesystem } from '../../shared/worktree-id'
import { parseWorkspaceKey } from '../../shared/workspace-scope'
import { inferFolderWorkspacePathConnection } from '../project-groups/folder-workspace-path-status'
import {
  declaredFolderHostId,
  declaredFolderOwnerHostId
} from './pane-skill-discovery-folder-owner'

export type PaneSkillDiscoveryWorkspace = {
  connectionId: string
  cwd: string
}

type HostSession = { hostId: ExecutionHostId; session: WorkspaceSessionState }

type PaneSkillDiscoveryWorkspaceArgs = {
  worktreeId: string
  terminalTabId?: string
  repos: readonly Repo[]
  projectGroups: readonly ProjectGroup[]
  folderWorkspaces: readonly FolderWorkspace[]
  worktreeMeta?: WorktreeMeta
  sessions: readonly HostSession[]
}

export function resolvePaneSkillDiscoveryWorkspace(
  args: PaneSkillDiscoveryWorkspaceArgs
): PaneSkillDiscoveryWorkspace {
  const scope = parseWorkspaceKey(args.worktreeId)
  const worktreeId = scope?.type === 'worktree' ? scope.worktreeId : args.worktreeId

  if (scope?.type === 'folder') {
    const workspaceCandidates = args.folderWorkspaces.filter(
      (candidate) => candidate.id === scope.folderWorkspaceId
    )
    const authoritativeFolderHostId = declaredFolderHostId(workspaceCandidates, args.projectGroups)
    const sessionOwner = findPaneSession(
      args.sessions,
      worktreeId,
      args.terminalTabId,
      authoritativeFolderHostId
    )
    const workspace = selectFolderWorkspace(
      workspaceCandidates,
      sessionOwner?.hostId ?? authoritativeFolderHostId ?? undefined
    )
    if (!workspace) {
      throw new Error('pane_skill_discovery_workspace_not_found')
    }
    const workspaceHostId = declaredFolderOwnerHostId(workspace)
    const group = selectFolderProjectGroup(
      args.projectGroups.filter((candidate) => candidate.id === workspace.projectGroupId),
      sessionOwner?.hostId ?? workspaceHostId
    )
    const groupHostId = group ? declaredFolderOwnerHostId(group) : null
    assertMatchingHost(workspaceHostId, groupHostId)
    const hostId =
      workspaceHostId ??
      groupHostId ??
      inferLegacyFolderHostId(workspace, args.projectGroups, args.repos)
    assertMatchingHost(sessionOwner?.hostId, hostId)
    return sshWorkspace(hostId, sessionOwner?.tab.startupCwd?.trim() || workspace.folderPath)
  }

  const parsed = splitWorktreeIdForFilesystem(worktreeId)
  if (!parsed?.repoId || !parsed.worktreePath) {
    throw new Error('pane_skill_discovery_workspace_not_found')
  }
  const candidates = args.repos.filter((repo) => repo.id === parsed.repoId)
  if (candidates.length === 0) {
    throw new Error('pane_skill_discovery_workspace_not_found')
  }
  const metaHostId = parseOptionalHostId(args.worktreeMeta?.hostId)
  const sessionOwner = findPaneSession(args.sessions, worktreeId, args.terminalTabId, metaHostId)
  assertMatchingHost(sessionOwner?.hostId, metaHostId)
  const knownHostId = sessionOwner?.hostId ?? metaHostId
  const repo = selectPaneRepo(candidates, knownHostId)
  const repoHostId = repoExecutionHostId(repo)
  const hostId = knownHostId ?? repoHostId
  if (knownHostId && hasExplicitRepoOwner(repo)) {
    assertMatchingHost(knownHostId, repoHostId)
  }
  const isPersistedWorktree = Boolean(sessionOwner || args.worktreeMeta)
  if (
    !isPersistedWorktree &&
    normalizeRuntimePathForComparison(parsed.worktreePath) !==
      normalizeRuntimePathForComparison(repo.path)
  ) {
    throw new Error('pane_skill_discovery_workspace_not_found')
  }
  return sshWorkspace(hostId, sessionOwner?.tab.startupCwd?.trim() || parsed.worktreePath)
}

function inferLegacyFolderHostId(
  workspace: FolderWorkspace,
  projectGroups: readonly ProjectGroup[],
  repos: readonly Repo[]
): ExecutionHostId {
  const connection = inferFolderWorkspacePathConnection({
    folderPath: workspace.folderPath,
    projectGroupId: workspace.projectGroupId,
    connectionId: null,
    projectGroups,
    repos
  })
  if (connection.kind === 'ambiguous') {
    throw new Error('pane_skill_discovery_owner_ambiguous')
  }
  return connection.kind === 'ssh'
    ? toSshExecutionHostId(connection.connectionId)
    : LOCAL_EXECUTION_HOST_ID
}

function selectFolderWorkspace(
  candidates: readonly FolderWorkspace[],
  hostId: ExecutionHostId | undefined
): FolderWorkspace | null {
  if (candidates.length === 0) {
    return null
  }
  if (candidates.length === 1) {
    return candidates[0]
  }
  if (!hostId) {
    throw new Error('pane_skill_discovery_owner_ambiguous')
  }
  const exact = candidates.filter((workspace) => {
    return declaredFolderOwnerHostId(workspace) === hostId
  })
  if (exact.length !== 1) {
    throw new Error('pane_skill_discovery_owner_ambiguous')
  }
  return exact[0]
}

function selectFolderProjectGroup(
  candidates: readonly ProjectGroup[],
  hostId: ExecutionHostId | null | undefined
): ProjectGroup | null {
  if (candidates.length === 0) {
    return null
  }
  if (candidates.length === 1) {
    return candidates[0]
  }
  if (!hostId) {
    throw new Error('pane_skill_discovery_owner_ambiguous')
  }
  const exact = candidates.filter((group) => declaredFolderOwnerHostId(group) === hostId)
  if (exact.length !== 1) {
    throw new Error('pane_skill_discovery_owner_ambiguous')
  }
  return exact[0]
}

function findPaneSession(
  sessions: readonly HostSession[],
  worktreeId: string,
  terminalTabId: string | undefined,
  authoritativeHostId?: ExecutionHostId | null
): { hostId: ExecutionHostId; tab: { ptyId: string | null; startupCwd?: string } } | null {
  if (!terminalTabId) {
    return null
  }
  const matches = sessions.flatMap(({ hostId, session }) =>
    Object.entries(session.tabsByWorktree ?? {}).flatMap(([candidateWorktreeId, tabs]) =>
      worktreeIdsEqual(candidateWorktreeId, worktreeId)
        ? tabs
            .filter((tab) => tab.id === terminalTabId)
            .map((tab) => ({ hostId, tab: { ptyId: tab.ptyId, startupCwd: tab.startupCwd } }))
        : []
    )
  )
  if (matches.length > 1) {
    const authoritativeMatches = authoritativeHostId
      ? matches.filter((match) => match.hostId === authoritativeHostId)
      : []
    const authoritativeMatch = authoritativeMatches.length === 1 ? authoritativeMatches[0] : null
    // Why: save compatibility mirrors remote tabs locally; only matching local rows yield to persisted ownership.
    if (
      authoritativeHostId !== LOCAL_EXECUTION_HOST_ID &&
      authoritativeMatch &&
      matches.every(
        (match) =>
          match === authoritativeMatch ||
          (match.hostId === LOCAL_EXECUTION_HOST_ID &&
            paneSessionsMirror(match.tab, authoritativeMatch.tab, authoritativeMatch.hostId))
      )
    ) {
      return authoritativeMatch
    }
    throw new Error('pane_skill_discovery_owner_ambiguous')
  }
  return matches[0] ?? null
}

function paneSessionsMirror(
  left: { ptyId: string | null; startupCwd?: string },
  right: { ptyId: string | null; startupCwd?: string },
  authoritativeHostId: ExecutionHostId
): boolean {
  const leftCwd = left.startupCwd?.trim() || null
  const rightCwd = right.startupCwd?.trim() || null
  if (!leftCwd || !rightCwd) {
    if (leftCwd === rightCwd) {
      return true
    }
    const host = parseExecutionHostId(authoritativeHostId)
    const pty = left.ptyId && left.ptyId === right.ptyId ? parseAppSshPtyId(left.ptyId) : null
    return host?.kind === 'ssh' && pty?.connectionId === host.targetId
  }
  return normalizeRuntimePathForComparison(leftCwd) === normalizeRuntimePathForComparison(rightCwd)
}

function selectPaneRepo(candidates: readonly Repo[], hostId: ExecutionHostId | null): Repo {
  if (!hostId) {
    if (candidates.length !== 1) {
      throw new Error('pane_skill_discovery_owner_ambiguous')
    }
    repoExecutionHostId(candidates[0])
    return candidates[0]
  }
  const exact = candidates.filter((repo) => repoExecutionHostId(repo) === hostId)
  if (exact.length === 1) {
    return exact[0]
  }
  const legacy = candidates.filter((repo) => !hasExplicitRepoOwner(repo))
  if (exact.length === 0 && legacy.length === 1) {
    return legacy[0]
  }
  throw new Error('pane_skill_discovery_owner_ambiguous')
}

function repoExecutionHostId(repo: Repo): ExecutionHostId {
  const hasHost = repo.executionHostId !== null && repo.executionHostId !== undefined
  const parsedHost = hasHost ? parseExecutionHostId(repo.executionHostId) : null
  if (hasHost && !parsedHost) {
    throw new Error('pane_skill_discovery_owner_invalid')
  }
  const connectionId = parseOptionalConnectionId(repo.connectionId)
  const connectionHostId = connectionId ? toSshExecutionHostId(connectionId) : null
  if (parsedHost && connectionHostId && parsedHost.id !== connectionHostId) {
    throw new Error('pane_skill_discovery_owner_invalid')
  }
  return parsedHost?.id ?? connectionHostId ?? LOCAL_EXECUTION_HOST_ID
}

function parseOptionalHostId(hostId: string | null | undefined): ExecutionHostId | null {
  if (hostId === null || hostId === undefined) {
    return null
  }
  const parsed = parseExecutionHostId(hostId)
  if (!parsed) {
    throw new Error('pane_skill_discovery_owner_invalid')
  }
  return parsed.id
}

function parseOptionalConnectionId(connectionId: string | null | undefined): string | null {
  if (connectionId === null || connectionId === undefined) {
    return null
  }
  const normalized = connectionId.trim()
  if (!normalized) {
    throw new Error('pane_skill_discovery_owner_invalid')
  }
  return normalized
}

function hasExplicitRepoOwner(repo: Repo): boolean {
  return Boolean(repo.executionHostId?.trim() || repo.connectionId?.trim())
}

function assertMatchingHost(
  left: ExecutionHostId | null | undefined,
  right: ExecutionHostId | null | undefined
): void {
  if (left && right && left !== right) {
    throw new Error('pane_skill_discovery_owner_ambiguous')
  }
}

function worktreeIdsEqual(left: string, right: string): boolean {
  const parsedLeft = splitWorktreeIdForFilesystem(left)
  const parsedRight = splitWorktreeIdForFilesystem(right)
  return parsedLeft && parsedRight
    ? parsedLeft.repoId === parsedRight.repoId &&
        normalizeRuntimePathForComparison(parsedLeft.worktreePath) ===
          normalizeRuntimePathForComparison(parsedRight.worktreePath)
    : left === right
}

function sshWorkspace(hostId: ExecutionHostId, cwd: string): PaneSkillDiscoveryWorkspace {
  const host = parseExecutionHostId(hostId)
  if (host?.kind !== 'ssh') {
    throw new Error('pane_skill_discovery_requires_ssh_workspace')
  }
  return { connectionId: host.targetId, cwd }
}
