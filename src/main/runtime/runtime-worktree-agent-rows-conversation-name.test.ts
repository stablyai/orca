import { describe, expect, it } from 'vitest'
import type { RuntimeWorktreePsSummary } from '../../shared/runtime-types'
import { attachRuntimeWorktreeAgentRows } from './runtime-worktree-agent-rows'
import type { RuntimeWorktreeAgentSource } from './runtime-worktree-agent-source'

const WORKTREE_ID = 'repo-1::/workspace/app'
const PARENT = 'tab-1:11111111-1111-4111-8111-111111111111'
const CHILD = 'tab-1:22222222-2222-4222-8222-222222222222'

function source(paneKey: string): RuntimeWorktreeAgentSource {
  return {
    paneKey,
    tabId: 'tab-1',
    worktreeId: WORKTREE_ID,
    connectionId: null,
    state: 'done',
    agentType: 'claude',
    prompt: '',
    lastAssistantMessage: null,
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: 1,
    updatedAt: 1
  }
}

function namesByPane(paneKeys: string[]): Record<string, string | undefined> {
  const summary: RuntimeWorktreePsSummary = {
    worktreeId: WORKTREE_ID,
    repoId: 'repo-1',
    repo: 'repo-1',
    path: '/workspace/app',
    branch: 'main',
    isArchived: false,
    isMainWorktree: true,
    hasHostSidebarActivity: false,
    parentWorktreeId: null,
    childWorktreeIds: [],
    displayName: 'app',
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
    terminalTitleEvidenceByWorktreeId: new Map(),
    rowSources: new Map(paneKeys.map((paneKey) => [paneKey, source(paneKey)])),
    orchestrationByPaneKey: { [CHILD]: { parentPaneKey: PARENT } },
    getSummary: (id) => summaries.get(id) ?? null,
    conversationName: () => 'Parent tab name'
  })
  return Object.fromEntries(summary.agents.map((row) => [row.paneKey, row.conversationName]))
}

describe("worktree ps agent row names, like desktop's compact rows", () => {
  it("keeps a listed parent's tab name off its child in the same tab", () => {
    expect(namesByPane([PARENT, CHILD])).toEqual({
      [PARENT]: 'Parent tab name',
      [CHILD]: undefined
    })
  })

  it('names the child by its tab once the parent row is gone', () => {
    expect(namesByPane([CHILD])).toEqual({ [CHILD]: 'Parent tab name' })
  })
})
