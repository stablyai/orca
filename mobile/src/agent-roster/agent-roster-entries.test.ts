import { describe, expect, it } from 'vitest'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import type { Worktree } from '../worktree/workspace-list-types'
import { buildAgentRosterEntries } from './agent-roster-entries'

function agent(overrides: Partial<RuntimeWorktreeAgentRow> = {}): RuntimeWorktreeAgentRow {
  return {
    paneKey: 'agent-1',
    parentPaneKey: null,
    state: 'working',
    agentType: 'claude',
    prompt: '',
    lastAssistantMessage: null,
    taskTitle: null,
    displayName: null,
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: 100,
    updatedAt: 200,
    ...overrides
  }
}

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    worktreeId: 'wt-1',
    repoId: 'repo-1',
    repo: 'orca',
    branch: 'main',
    displayName: 'manta',
    path: '/tmp/orca/manta',
    liveTerminalCount: 0,
    hasAttachedPty: false,
    preview: '',
    unread: false,
    isPinned: false,
    linkedPR: null,
    ...overrides
  }
}

describe('buildAgentRosterEntries', () => {
  it('flattens agents across worktrees, labelling each with its own worktree', () => {
    const entries = buildAgentRosterEntries([
      worktree({ worktreeId: 'wt-a', displayName: 'alpha', agents: [agent({ paneKey: 'p1' })] }),
      worktree({
        worktreeId: 'wt-b',
        repo: 'beta-repo',
        displayName: '',
        agents: [agent({ paneKey: 'p2' })]
      })
    ])

    expect(entries.map((entry) => [entry.worktreeId, entry.worktreeLabel])).toEqual([
      ['wt-a', 'alpha'],
      // A blank displayName falls back to repo, exactly as the sidebar row does.
      ['wt-b', 'beta-repo']
    ])
  })

  it('orders by updatedAt desc, then stateStartedAt desc, then key', () => {
    const entries = buildAgentRosterEntries([
      worktree({
        worktreeId: 'wt',
        agents: [
          agent({ paneKey: 'old', updatedAt: 10 }),
          agent({ paneKey: 'new', updatedAt: 30 }),
          agent({ paneKey: 'mid-b', updatedAt: 20, stateStartedAt: 1 }),
          agent({ paneKey: 'mid-a', updatedAt: 20, stateStartedAt: 2 })
        ]
      })
    ])

    expect(entries.map((entry) => entry.agent.paneKey)).toEqual(['new', 'mid-a', 'mid-b', 'old'])
  })

  it('scopes a shared paneKey by worktree so roster keys stay globally unique', () => {
    const entries = buildAgentRosterEntries([
      worktree({ worktreeId: 'wt-a', agents: [agent({ paneKey: 'shared' })] }),
      worktree({ worktreeId: 'wt-b', agents: [agent({ paneKey: 'shared' })] })
    ])

    expect(new Set(entries.map((entry) => entry.key)).size).toBe(2)
  })

  it('gives two same-paneKey rows in one worktree distinct keys', () => {
    const entries = buildAgentRosterEntries([
      worktree({ worktreeId: 'wt', agents: [agent({ paneKey: 'dup' }), agent({ paneKey: 'dup' })] })
    ])

    expect(new Set(entries.map((entry) => entry.key)).size).toBe(2)
  })

  it('skips worktrees without agents and tolerates a missing agents field', () => {
    const entries = buildAgentRosterEntries([
      worktree({ worktreeId: 'wt-empty', agents: [] }),
      worktree({ worktreeId: 'wt-absent' }),
      worktree({ worktreeId: 'wt-with', agents: [agent({ paneKey: 'p' })] })
    ])

    expect(entries).toHaveLength(1)
    expect(entries[0]?.worktreeId).toBe('wt-with')
  })

  it('returns an empty list for an empty host', () => {
    expect(buildAgentRosterEntries([])).toEqual([])
  })

  it('tolerates a non-array agents field from a malformed row', () => {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a salvaged host row can carry any type here, which is the input this test exists to cover.
    const malformed = { nope: true } as unknown as RuntimeWorktreeAgentRow[]
    expect(
      buildAgentRosterEntries([worktree({ worktreeId: 'wt-bad', agents: malformed })])
    ).toEqual([])
  })

  it('does not mutate its input', () => {
    const agents = [agent({ paneKey: 'a' }), agent({ paneKey: 'b', updatedAt: 1 })]
    const list = [worktree({ worktreeId: 'wt', agents })]
    const before = structuredClone(list)

    buildAgentRosterEntries(list)

    expect(list[0]?.agents).toBe(agents)
    expect(list).toEqual(before)
  })
})
