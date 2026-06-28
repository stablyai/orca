import { join, sep } from 'node:path'
import type {
  RuntimeWorktreeAgentRow,
  RuntimeWorktreePsResult,
  RuntimeWorktreePsSummary
} from '../../shared/runtime-types'

export function makeAgentRow(
  overrides: Partial<RuntimeWorktreeAgentRow> = {}
): RuntimeWorktreeAgentRow {
  return {
    paneKey: 'pane-1',
    parentPaneKey: null,
    state: 'working',
    agentType: 'claude',
    prompt: 'do the thing',
    lastAssistantMessage: null,
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: 1000,
    updatedAt: 1000,
    ...overrides
  }
}

export function makeWorktreeSummary(
  overrides: Partial<RuntimeWorktreePsSummary> = {}
): RuntimeWorktreePsSummary {
  return {
    worktreeId: 'wt-1',
    repoId: 'repo-1',
    repo: 'web-app',
    path: join(sep, 'work', 'web-app'),
    branch: 'feature/x',
    parentWorktreeId: null,
    childWorktreeIds: [],
    displayName: 'feature/x',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    comment: '',
    isPinned: false,
    isActive: false,
    unread: false,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    lastOutputAt: null,
    preview: '',
    status: 'active',
    agents: [],
    ...overrides
  }
}

export function makePsResult(
  worktrees: RuntimeWorktreePsSummary[],
  overrides: Partial<Omit<RuntimeWorktreePsResult, 'worktrees'>> = {}
): RuntimeWorktreePsResult {
  return {
    worktrees,
    totalCount: worktrees.length,
    truncated: false,
    ...overrides
  }
}
