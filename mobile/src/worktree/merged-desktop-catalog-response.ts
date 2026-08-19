import { normalizeExecutionHostId } from '../../../src/shared/execution-host'
import { readMobileRepoCatalog } from '../cache/repo-cache'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import type { RepoSummary } from './host-worktree-rpc-types'
import type { Worktree } from './workspace-list-types'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function isOptionalNullableString(value: unknown): boolean {
  return value === null || isOptionalString(value)
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean'
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value)
}

function isOptionalNullableNumber(value: unknown): boolean {
  return value === null || isOptionalNumber(value)
}

function isOptionalStringArray(value: unknown): boolean {
  return (
    value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string'))
  )
}

function isLinkedPullRequest(value: unknown): value is Worktree['linkedPR'] {
  return (
    value === null ||
    (isRecord(value) && isFiniteNumber(value.number) && typeof value.state === 'string')
  )
}

function isAgentState(value: unknown): boolean {
  return value === 'working' || value === 'blocked' || value === 'waiting' || value === 'done'
}

function isAgent(value: unknown): value is RuntimeWorktreeAgentRow {
  return (
    isRecord(value) &&
    typeof value.paneKey === 'string' &&
    value.paneKey.length > 0 &&
    (value.parentPaneKey === null || typeof value.parentPaneKey === 'string') &&
    isAgentState(value.state) &&
    (value.agentType === null ||
      (typeof value.agentType === 'string' && value.agentType.length > 0)) &&
    typeof value.prompt === 'string' &&
    isOptionalNullableString(value.taskTitle) &&
    isOptionalNullableString(value.displayName) &&
    isOptionalNullableString(value.lastAssistantMessage) &&
    isOptionalNullableString(value.toolName) &&
    isOptionalNullableString(value.toolInput) &&
    typeof value.interrupted === 'boolean' &&
    isFiniteNumber(value.stateStartedAt) &&
    isFiniteNumber(value.updatedAt) &&
    isOptionalBoolean(value.restoredUnconfirmed)
  )
}

function isOptionalAgents(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.every(isAgent))
}

function isWorktree(value: unknown): value is Worktree {
  if (!isRecord(value)) {
    return false
  }
  const kind = value.workspaceKind
  const hostId = value.hostId
  return (
    (kind === undefined || kind === 'git' || kind === 'folder-workspace') &&
    (hostId === undefined ||
      (typeof hostId === 'string' && normalizeExecutionHostId(hostId) !== null)) &&
    typeof value.worktreeId === 'string' &&
    value.worktreeId.length > 0 &&
    typeof value.repoId === 'string' &&
    typeof value.repo === 'string' &&
    typeof value.branch === 'string' &&
    typeof value.displayName === 'string' &&
    typeof value.path === 'string' &&
    isFiniteNumber(value.liveTerminalCount) &&
    typeof value.hasAttachedPty === 'boolean' &&
    typeof value.preview === 'string' &&
    typeof value.unread === 'boolean' &&
    typeof value.isPinned === 'boolean' &&
    isLinkedPullRequest(value.linkedPR) &&
    (value.sectionListKey === undefined || typeof value.sectionListKey === 'string') &&
    (value.executionHostFilterId === undefined ||
      typeof value.executionHostFilterId === 'string') &&
    (value.executionHostFilterLabel === undefined ||
      typeof value.executionHostFilterLabel === 'string') &&
    (value.terminalPlatform === undefined || typeof value.terminalPlatform === 'string') &&
    (value.workspaceStatus === undefined || typeof value.workspaceStatus === 'string') &&
    isOptionalNumber(value.sortOrder) &&
    isOptionalNumber(value.manualOrder) &&
    isOptionalNumber(value.lastActivityAt) &&
    isOptionalNumber(value.createdAt) &&
    isOptionalBoolean(value.isArchived) &&
    isOptionalBoolean(value.isMainWorktree) &&
    isOptionalBoolean(value.hasHostSidebarActivity) &&
    isOptionalString(value.worktreeInstanceId) &&
    isOptionalString(value.lineageWorktreeInstanceId) &&
    isOptionalString(value.parentWorktreeInstanceId) &&
    isOptionalNullableString(value.parentWorktreeId) &&
    isOptionalStringArray(value.childWorktreeIds) &&
    isOptionalNumber(value.lineageDepth) &&
    isOptionalNumber(value.lineageChildCount) &&
    isOptionalBoolean(value.lineageCollapsed) &&
    isOptionalBoolean(value.isLastLineageChild) &&
    isOptionalNullableNumber(value.lastOutputAt) &&
    isOptionalBoolean(value.isActive) &&
    isOptionalNullableNumber(value.linkedIssue) &&
    isOptionalNullableString(value.linkedLinearIssue) &&
    isOptionalNullableNumber(value.linkedGitLabMR) &&
    isOptionalNullableNumber(value.linkedGitLabIssue) &&
    (value.comment === undefined || typeof value.comment === 'string') &&
    (value.status === undefined ||
      value.status === 'working' ||
      value.status === 'active' ||
      value.status === 'permission' ||
      value.status === 'done' ||
      value.status === 'inactive') &&
    isOptionalAgents(value.agents)
  )
}

export function readMergedWorktreeCatalog(value: unknown): Worktree[] | null {
  if (!isRecord(value)) {
    return null
  }
  return readMergedWorktreeRows(value.worktrees)
}

export function readMergedWorktreeRows(value: unknown): Worktree[] | null {
  if (!Array.isArray(value) || !value.every(isWorktree)) {
    return null
  }
  return value.map((worktree) => ({
    ...worktree,
    ...(worktree.linkedPR ? { linkedPR: { ...worktree.linkedPR } } : {}),
    ...(worktree.childWorktreeIds ? { childWorktreeIds: [...worktree.childWorktreeIds] } : {}),
    ...(worktree.agents ? { agents: worktree.agents.map((agent) => ({ ...agent })) } : {})
  }))
}

export function readMergedRepoCatalog(value: unknown): RepoSummary[] | null {
  if (!isRecord(value) || !Array.isArray(value.repos)) {
    return null
  }
  return readMobileRepoCatalog(value.repos)
}
