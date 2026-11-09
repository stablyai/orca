import { describe, expect, it } from 'vitest'
import type { AgentListPublication } from '../../../../shared/agent-status/presentation/agent-list-status'
import type { RuntimeWorktreePsSummary } from '../../../../shared/runtime-worktree-contracts'
import { attachRuntimeWorktreeAgentRows } from './runtime-worktree-agent-rows'
import type { RuntimeWorktreeAgentSource } from './runtime-worktree-agent-source'

const WORKTREE_ID = 'repo::/work/tree'
const PUBLISHED_AT = 1_800_000_000_000

function source(paneKey: string, updatedAt: number): RuntimeWorktreeAgentSource {
  return {
    paneKey,
    worktreeId: WORKTREE_ID,
    connectionId: null,
    state: 'done',
    agentType: 'claude',
    prompt: 'fix it',
    lastAssistantMessage: null,
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: updatedAt,
    updatedAt
  }
}

function listAgents(agentList: AgentListPublication | null) {
  const summary: RuntimeWorktreePsSummary = {
    worktreeId: WORKTREE_ID,
    repoId: 'repo',
    repo: 'repo',
    path: '/work/tree',
    branch: 'main',
    isArchived: false,
    isMainWorktree: false,
    hasHostSidebarActivity: false,
    parentWorktreeId: null,
    childWorktreeIds: [],
    displayName: 'tree',
    workspaceStatus: '',
    sortOrder: 0,
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
    status: 'inactive',
    agents: []
  }
  const summaries = new Map([[WORKTREE_ID, summary]])
  attachRuntimeWorktreeAgentRows({
    summaries,
    rowSources: new Map(
      [
        source('tab-1:listed', PUBLISHED_AT - 3),
        source('tab-1:session-start', PUBLISHED_AT - 2),
        source('tab-1:unknown-old', PUBLISHED_AT - 1),
        source('tab-1:unknown-new', PUBLISHED_AT + 1)
      ].map((row) => [row.paneKey, row])
    ),
    terminalTitleEvidenceByRow: new Map(),
    orchestrationByPaneKey: null,
    getSummary: (id) => summaries.get(id) ?? null,
    agentList
  })
  return Object.fromEntries((summary.agents ?? []).map((row) => [row.paneKey, row.activity]))
}

describe('worktree.ps agent rows and the desktop Agents list', () => {
  it('carries each pane’s verdict and holds back only turns newer than the verdicts', () => {
    const listed = {
      listed: true,
      status: 'done',
      unread: true,
      clearable: true,
      sortAt: PUBLISHED_AT - 3,
      title: 'Fix the build',
      childOf: 'tab-0:coordinator',
      foldedChild: true
    } as const
    expect(
      listAgents({
        publishedAt: PUBLISHED_AT,
        verdicts: { 'tab-1:listed': listed, 'tab-1:session-start': { listed: false } }
      })
    ).toEqual({
      'tab-1:listed': listed,
      'tab-1:session-start': { listed: false },
      'tab-1:unknown-old': { listed: false },
      'tab-1:unknown-new': undefined
    })
  })
})
