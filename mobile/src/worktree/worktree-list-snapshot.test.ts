import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import type { Worktree } from './workspace-list-sections'
import { areWorktreeListsEqual } from './worktree-list-snapshot'

function agent(overrides: Partial<RuntimeWorktreeAgentRow> = {}): RuntimeWorktreeAgentRow {
  return {
    paneKey: 'agent-1',
    parentPaneKey: null,
    state: 'working',
    agentType: 'codex',
    prompt: 'fix mobile lag',
    lastAssistantMessage: null,
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: 100,
    updatedAt: 200,
    ...overrides
  }
}

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  const worktreePath = join('/tmp', 'orca', 'worktrees', 'manta')
  return {
    worktreeId: `repo-1::${worktreePath}`,
    repoId: 'repo-1',
    repo: 'orca',
    branch: 'feature/mobile-lag',
    displayName: 'manta',
    workspaceStatus: 'in-progress',
    path: worktreePath,
    liveTerminalCount: 1,
    hasAttachedPty: true,
    preview: '$ codex',
    unread: false,
    lastOutputAt: 1234,
    isPinned: false,
    isActive: false,
    linkedPR: null,
    linkedIssue: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    comment: '',
    status: 'active',
    agents: [],
    ...overrides
  }
}

describe('areWorktreeListsEqual', () => {
  it('treats cloned snapshots with the same visible fields as equal', () => {
    const first = [worktree({ agents: [agent()] })]
    const second = [worktree({ agents: [agent()] })]

    expect(areWorktreeListsEqual(first, second)).toBe(true)
  })

  it('detects order and field changes that affect the host list', () => {
    const first = [worktree({ worktreeId: 'a' }), worktree({ worktreeId: 'b' })]
    const reordered = [worktree({ worktreeId: 'b' }), worktree({ worktreeId: 'a' })]
    const renamed = [
      worktree({ worktreeId: 'a', displayName: 'renamed' }),
      worktree({ worktreeId: 'b' })
    ]

    expect(areWorktreeListsEqual(first, reordered)).toBe(false)
    expect(areWorktreeListsEqual(first, renamed)).toBe(false)
  })

  it('detects host visibility field changes', () => {
    expect(areWorktreeListsEqual([worktree()], [worktree({ isArchived: true })])).toBe(false)
    expect(areWorktreeListsEqual([worktree()], [worktree({ isMainWorktree: true })])).toBe(false)
    expect(areWorktreeListsEqual([worktree()], [worktree({ hasHostSidebarActivity: true })])).toBe(
      false
    )
  })

  it('detects workspace status changes', () => {
    expect(
      areWorktreeListsEqual(
        [worktree({ workspaceStatus: 'in-progress' })],
        [worktree({ workspaceStatus: 'in-review' })]
      )
    ).toBe(false)
  })

  it('detects manual order changes', () => {
    expect(
      areWorktreeListsEqual(
        [worktree({ manualOrder: 10, sortOrder: 1 })],
        [worktree({ manualOrder: 20, sortOrder: 1 })]
      )
    ).toBe(false)
  })

  it('detects desktop ordering field changes', () => {
    expect(
      areWorktreeListsEqual(
        [worktree({ lastActivityAt: 10, createdAt: 1 })],
        [worktree({ lastActivityAt: 20, createdAt: 1 })]
      )
    ).toBe(false)
    expect(
      areWorktreeListsEqual(
        [worktree({ lastActivityAt: 10, createdAt: 1 })],
        [worktree({ lastActivityAt: 10, createdAt: 2 })]
      )
    ).toBe(false)
  })

  it('detects resume host and terminal platform changes', () => {
    expect(areWorktreeListsEqual([worktree()], [worktree({ hostId: 'ssh:box' })])).toBe(false)
    expect(
      areWorktreeListsEqual(
        [worktree({ terminalPlatform: 'win32' })],
        [worktree({ terminalPlatform: 'linux' })]
      )
    ).toBe(false)
  })

  it('detects lineage changes', () => {
    const base = worktree({ worktreeId: 'child', parentWorktreeId: 'parent-a' })
    const changedParent = worktree({ worktreeId: 'child', parentWorktreeId: 'parent-b' })
    const changedChildren = worktree({
      worktreeId: 'child',
      parentWorktreeId: 'parent-a',
      childWorktreeIds: ['grandchild']
    })

    expect(areWorktreeListsEqual([base], [changedParent])).toBe(false)
    expect(areWorktreeListsEqual([base], [changedChildren])).toBe(false)
  })

  it('detects lineage instance changes', () => {
    const base = worktree({
      worktreeId: 'child',
      parentWorktreeId: 'parent',
      worktreeInstanceId: 'child-instance',
      lineageWorktreeInstanceId: 'child-instance',
      parentWorktreeInstanceId: 'parent-instance'
    })
    const changedParentInstance = worktree({
      worktreeId: 'child',
      parentWorktreeId: 'parent',
      worktreeInstanceId: 'child-instance',
      lineageWorktreeInstanceId: 'child-instance',
      parentWorktreeInstanceId: 'new-parent-instance'
    })

    expect(areWorktreeListsEqual([base], [changedParentInstance])).toBe(false)
  })

  it('detects agent status changes', () => {
    const first = [worktree({ agents: [agent({ state: 'working' })] })]
    const second = [worktree({ agents: [agent({ state: 'waiting' })] })]

    expect(areWorktreeListsEqual(first, second)).toBe(false)
  })

  it('treats missing and empty agent arrays as equivalent for rendering', () => {
    const first = [worktree({ agents: undefined })]
    const second = [worktree({ agents: [] })]

    expect(areWorktreeListsEqual(first, second)).toBe(true)
  })

  it('detects agent context-pressure changes', () => {
    const base = [
      worktree({ agents: [agent({ contextPressure: { level: 'warning', usedPercent: 75 } })] })
    ]

    // Unchanged reading (host pre-clamps to integers) compares equal across polls.
    expect(
      areWorktreeListsEqual(base, [
        worktree({ agents: [agent({ contextPressure: { level: 'warning', usedPercent: 75 } })] })
      ])
    ).toBe(true)
    expect(
      areWorktreeListsEqual(base, [
        worktree({ agents: [agent({ contextPressure: { level: 'critical', usedPercent: 92 } })] })
      ])
    ).toBe(false)
    expect(
      areWorktreeListsEqual(base, [
        worktree({ agents: [agent({ contextPressure: { level: 'warning', usedPercent: 80 } })] })
      ])
    ).toBe(false)
    // Reading disappearing (gate turned off host-side) must clear the indicator.
    expect(areWorktreeListsEqual(base, [worktree({ agents: [agent()] })])).toBe(false)
  })

  it('detects exact pressure detail changes at the same rounded percentage', () => {
    const pressure = {
      level: 'critical' as const,
      usedPercent: 95,
      usedTokens: 190_000,
      limitTokens: 200_000,
      limitSource: 'model' as const,
      usedTokensSource: 'provider' as const
    }
    const base = [worktree({ agents: [agent({ contextPressure: pressure })] })]

    for (const contextPressure of [
      { ...pressure, usedTokens: 950_000 },
      { ...pressure, limitTokens: 1_000_000 },
      { ...pressure, limitSource: 'soft-cap' as const },
      { ...pressure, usedTokensSource: 'derived-percent' as const }
    ]) {
      expect(
        areWorktreeListsEqual(base, [worktree({ agents: [agent({ contextPressure })] })])
      ).toBe(false)
    }
  })
})
