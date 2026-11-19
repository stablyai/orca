import { describe, expect, it } from 'vitest'
import type { RuntimeWorktreePsSummary } from '../../shared/worktree/catalog/runtime-worktree-contracts'
import { formatWorktreePs } from './worktree-ps-format'
import { recentWorktreePs } from './worktree-ps-recent'

const NOW = 1_800_000_000_000

function row(overrides: Partial<RuntimeWorktreePsSummary>): RuntimeWorktreePsSummary {
  return {
    workspaceKind: 'git',
    worktreeId: 'repo::/w/webhooks',
    repoId: 'repo',
    hostId: 'local',
    repo: 'orca',
    path: '/w/webhooks',
    branch: 'alice/headless-automation-sleep-per-run',
    isArchived: false,
    isMainWorktree: false,
    hasHostSidebarActivity: false,
    parentWorktreeId: null,
    childWorktreeIds: [],
    displayName: 'webhooks',
    workspaceStatus: 'in-progress',
    sortOrder: 0,
    lastActivityAt: NOW - 25 * 60_000,
    linkedIssue: null,
    linkedPR: {
      number: 29811,
      state: 'merged',
      title: 'Sleep headless runs',
      checksStatus: 'success'
    },
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    comment: '',
    isPinned: false,
    isActive: false,
    unread: false,
    liveTerminalCount: 1,
    hasAttachedPty: true,
    unverifiableTerminalCount: 0,
    lastOutputAt: null,
    preview: '',
    status: 'active',
    agents: [],
    ...overrides
  }
}

const AGENT = {
  paneKey: 'tab:leaf',
  address: 'term_1',
  parentPaneKey: null,
  state: 'done' as const,
  agentType: 'claude',
  prompt: 'list a taken-over workspace under the bot row',
  taskTitle: null,
  displayName: null,
  lastAssistantMessage: 'Pushed to #388; build running.',
  toolName: null,
  toolInput: null,
  interrupted: false,
  stateStartedAt: NOW - 25 * 60_000,
  updatedAt: NOW - 25 * 60_000
}

describe('formatWorktreePs', () => {
  it('shows what a reader needs to tell the work apart', () => {
    const text = formatWorktreePs(
      { worktrees: [row({ agents: [AGENT], bot: 'Atlas' })], totalCount: 1, truncated: false },
      NOW
    )
    expect(text).toContain('webhooks · orca · host=local')
    expect(text).toContain('active 25m ago · under bot Atlas')
    expect(text).toContain('--worktree id:repo::/w/webhooks')
    expect(text).toContain(
      'earlier work: branch alice/headless-automation-sleep-per-run · PR #29811 merged "Sleep headless runs", checks success'
    )
    expect(text.indexOf('last said:')).toBeLessThan(text.indexOf('earlier work:'))
    expect(text).toContain('agent claude idle, 25m ago (--terminal term_1)')
    expect(text).toContain('last asked: list a taken-over workspace under the bot row')
    expect(text).toContain('last said: Pushed to #388; build running.')
  })

  it('says a live agent with no handle is open but cannot be messaged yet, not idle', () => {
    const { address: _address, ...restored } = AGENT
    const text = formatWorktreePs(
      {
        worktrees: [row({ agents: [{ ...restored, hasLivePty: true }] })],
        totalCount: 1,
        truncated: false
      },
      NOW
    )
    expect(text).toContain('agent claude open, no handle yet, 25m ago')
    expect(text).not.toContain('--terminal')
  })

  it("drops the terminal's last line when an agent's own words are there", () => {
    const preview = 'API Error: 502 Bad Gateway'
    const withAgent = formatWorktreePs(
      { worktrees: [row({ agents: [AGENT], preview })], totalCount: 1, truncated: false },
      NOW
    )
    const plain = formatWorktreePs(
      { worktrees: [row({ preview })], totalCount: 1, truncated: false },
      NOW
    )
    expect(withAgent).not.toContain('preview:')
    expect(plain).toContain(`preview: ${preview}`)
  })
})

describe('recentWorktreePs', () => {
  it('keeps recent rows, newest first, by the workspace or its agents', () => {
    const old = row({ worktreeId: 'old', lastActivityAt: NOW - 10 * 86_400_000 })
    const agentRecent = row({
      worktreeId: 'agent',
      lastActivityAt: NOW - 10 * 86_400_000,
      agents: [{ ...AGENT, updatedAt: NOW - 60_000 }]
    })
    const recent = row({ worktreeId: 'recent', lastActivityAt: NOW - 3_600_000 })
    const result = recentWorktreePs(
      { worktrees: [old, recent, agentRecent], totalCount: 3, truncated: false },
      NOW - 7 * 86_400_000,
      undefined
    )
    expect(result.worktrees.map((entry) => entry.worktreeId)).toEqual(['agent', 'recent'])
    expect(result.totalCount).toBe(2)
  })

  it('caps after filtering and says so', () => {
    const rows = ['a', 'b', 'c'].map((id, index) =>
      row({ worktreeId: id, lastActivityAt: NOW - index * 60_000 })
    )
    const result = recentWorktreePs(
      { worktrees: rows, totalCount: 3, truncated: false },
      NOW - 86_400_000,
      2
    )
    expect(result.worktrees.map((entry) => entry.worktreeId)).toEqual(['a', 'b'])
    expect(result.truncated).toBe(true)
  })
})
