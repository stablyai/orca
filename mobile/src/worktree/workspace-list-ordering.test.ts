import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import { AGENT_STATUS_STALE_AFTER_MS } from './agent-row-display'
import { getWorktreeStatus, sortWorktrees } from './workspace-list-ordering'
import type { Worktree } from './workspace-list-types'

const failedMain = { state: 'done' as const, outcome: 'failure' as const, stateStartedAt: 0 }

function agent(overrides: Partial<RuntimeWorktreeAgentRow> = {}): RuntimeWorktreeAgentRow {
  return {
    paneKey: 'pane-1',
    parentPaneKey: null,
    state: 'done',
    agentType: 'claude',
    prompt: '',
    taskTitle: null,
    displayName: null,
    lastAssistantMessage: null,
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: 0,
    updatedAt: 0,
    ...overrides
  }
}

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  const worktreePath = join('/tmp', 'orca', 'worktrees', 'feature')
  return {
    workspaceKind: 'git',
    worktreeId: `repo-1::${worktreePath}`,
    repoId: 'repo-1',
    repo: 'orca',
    branch: 'feature/mobile-parity',
    displayName: 'feature',
    path: worktreePath,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    preview: '',
    unread: false,
    isPinned: false,
    linkedPR: null,
    status: 'inactive',
    agents: [],
    ...overrides
  }
}

describe('getWorktreeStatus', () => {
  it('shows failed from a failed agent row under a working or done host rollup', () => {
    // Held open by child work: the host still reports working.
    expect(
      getWorktreeStatus(
        worktree({
          status: 'working',
          agents: [agent({ state: 'working', mainAgent: failedMain })]
        }),
        0
      )
    ).toBe('failed')
    expect(
      getWorktreeStatus(
        worktree({ status: 'done', agents: [agent({ state: 'done', mainAgent: failedMain })] }),
        0
      )
    ).toBe('failed')
  })

  it('keeps showing failed once the row is past the staleness window', () => {
    expect(
      getWorktreeStatus(
        worktree({ status: 'done', agents: [agent({ state: 'done', mainAgent: failedMain })] }),
        AGENT_STATUS_STALE_AFTER_MS + 1
      )
    ).toBe('failed')
  })

  it('lets a host permission rollup outrank a failed row', () => {
    expect(
      getWorktreeStatus(
        worktree({
          status: 'permission',
          agents: [agent({ state: 'done', mainAgent: failedMain })]
        }),
        0
      )
    ).toBe('permission')
  })

  it('lets a child waiting on the user outrank a failed row', () => {
    expect(
      getWorktreeStatus(
        worktree({
          status: 'working',
          agents: [
            agent({ paneKey: 'lead', state: 'done', mainAgent: failedMain }),
            agent({ paneKey: 'child', parentPaneKey: 'lead', state: 'waiting' })
          ]
        }),
        0
      )
    ).toBe('permission')
  })

  it('does not raise a human wait from a stale waiting row', () => {
    expect(
      getWorktreeStatus(
        worktree({ status: 'working', agents: [agent({ state: 'waiting', updatedAt: 0 })] }),
        AGENT_STATUS_STALE_AFTER_MS + 1
      )
    ).toBe('working')
  })

  it('keeps the host value when no row carries a main-agent record', () => {
    for (const status of ['working', 'done', 'active', 'inactive'] as const) {
      expect(
        getWorktreeStatus(
          worktree({
            status,
            hasHostSidebarActivity: undefined,
            agents: [agent({ state: 'done' }), agent({ state: 'done', interrupted: true })]
          }),
          0
        )
      ).toBe(status)
    }
  })
})

describe('sortWorktrees agent attention fallback', () => {
  it('orders failed after permission and before working', () => {
    // Display names are reverse-alphabetical so only the status rank can order them.
    const permission = worktree({
      worktreeId: 'permission',
      displayName: 'Zebra',
      status: 'permission'
    })
    const failed = worktree({
      worktreeId: 'failed',
      displayName: 'Yak',
      status: 'done',
      agents: [agent({ mainAgent: failedMain })]
    })
    const working = worktree({ worktreeId: 'working', displayName: 'Xerus', status: 'working' })
    const done = worktree({ worktreeId: 'done', displayName: 'Wolf', status: 'done' })

    expect(
      sortWorktrees([done, working, failed, permission], 'smart', 0).map((w) => w.worktreeId)
    ).toEqual(['permission', 'failed', 'working', 'done'])
  })
})
