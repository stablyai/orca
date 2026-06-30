import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import type { Worktree } from './workspace-list-sections'

export function areWorktreeListsEqual(
  left: readonly Worktree[],
  right: readonly Worktree[]
): boolean {
  if (left === right) {
    return true
  }
  if (left.length !== right.length) {
    return false
  }
  for (let index = 0; index < left.length; index += 1) {
    if (!areWorktreesEqual(left[index]!, right[index]!)) {
      return false
    }
  }
  return true
}

function areWorktreesEqual(left: Worktree, right: Worktree): boolean {
  return (
    left.worktreeId === right.worktreeId &&
    left.repoId === right.repoId &&
    left.repo === right.repo &&
    left.branch === right.branch &&
    left.displayName === right.displayName &&
    (left.workspaceStatus ?? null) === (right.workspaceStatus ?? null) &&
    (left.sortOrder ?? null) === (right.sortOrder ?? null) &&
    (left.manualOrder ?? null) === (right.manualOrder ?? null) &&
    left.path === right.path &&
    (left.isArchived ?? false) === (right.isArchived ?? false) &&
    (left.isMainWorktree ?? false) === (right.isMainWorktree ?? false) &&
    (left.hasHostSidebarActivity ?? false) === (right.hasHostSidebarActivity ?? false) &&
    (left.parentWorktreeId ?? null) === (right.parentWorktreeId ?? null) &&
    areStringArraysEqual(left.childWorktreeIds ?? [], right.childWorktreeIds ?? []) &&
    left.liveTerminalCount === right.liveTerminalCount &&
    left.hasAttachedPty === right.hasAttachedPty &&
    left.preview === right.preview &&
    left.unread === right.unread &&
    (left.lastOutputAt ?? null) === (right.lastOutputAt ?? null) &&
    left.isPinned === right.isPinned &&
    (left.isActive ?? false) === (right.isActive ?? false) &&
    (left.linkedIssue ?? null) === (right.linkedIssue ?? null) &&
    (left.linkedLinearIssue ?? null) === (right.linkedLinearIssue ?? null) &&
    (left.linkedGitLabMR ?? null) === (right.linkedGitLabMR ?? null) &&
    (left.linkedGitLabIssue ?? null) === (right.linkedGitLabIssue ?? null) &&
    (left.comment ?? '') === (right.comment ?? '') &&
    (left.status ?? null) === (right.status ?? null) &&
    arePullRequestsEqual(left.linkedPR, right.linkedPR) &&
    areAgentRowsEqual(left.agents ?? [], right.agents ?? [])
  )
}

function areStringArraysEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left === right) {
    return true
  }
  if (left.length !== right.length) {
    return false
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false
    }
  }
  return true
}

function arePullRequestsEqual(left: Worktree['linkedPR'], right: Worktree['linkedPR']): boolean {
  if (left === right) {
    return true
  }
  if (!left || !right) {
    return false
  }
  return left.number === right.number && left.state === right.state
}

function areAgentRowsEqual(
  left: readonly RuntimeWorktreeAgentRow[],
  right: readonly RuntimeWorktreeAgentRow[]
): boolean {
  if (left === right) {
    return true
  }
  if (left.length !== right.length) {
    return false
  }
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index]!
    const b = right[index]!
    if (
      a.paneKey !== b.paneKey ||
      a.parentPaneKey !== b.parentPaneKey ||
      a.state !== b.state ||
      a.agentType !== b.agentType ||
      a.prompt !== b.prompt ||
      a.lastAssistantMessage !== b.lastAssistantMessage ||
      a.toolName !== b.toolName ||
      a.toolInput !== b.toolInput ||
      a.interrupted !== b.interrupted ||
      a.stateStartedAt !== b.stateStartedAt ||
      a.updatedAt !== b.updatedAt
    ) {
      return false
    }
  }
  return true
}
