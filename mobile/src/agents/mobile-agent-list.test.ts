import { describe, expect, it } from 'vitest'
import type { RuntimeWorktreeAgentRow } from '../../../src/shared/runtime-types'
import type { Worktree } from '../worktree/workspace-list-sections'
import {
  buildMobileAgentThreads,
  filterMobileAgentThreads,
  groupMobileAgentThreads
} from './mobile-agent-list'

const NOW = 1_000_000

function agent(
  paneKey: string,
  overrides: Partial<RuntimeWorktreeAgentRow> = {}
): RuntimeWorktreeAgentRow {
  return {
    paneKey,
    parentPaneKey: null,
    state: 'working',
    agentType: 'claude',
    prompt: 'Default prompt',
    lastAssistantMessage: null,
    toolName: null,
    toolInput: null,
    interrupted: false,
    stateStartedAt: NOW,
    updatedAt: NOW,
    ...overrides
  }
}

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    workspaceKind: 'git',
    worktreeId: 'wt-a',
    repoId: 'repo-a',
    repo: 'orca',
    branch: 'feat/mobile-agents',
    displayName: 'Mobile Agents',
    path: '/tmp/orca/mobile-agents',
    liveTerminalCount: 0,
    hasAttachedPty: false,
    preview: '',
    unread: false,
    isPinned: false,
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

describe('buildMobileAgentThreads', () => {
  it('returns empty when no worktrees or agents exist', () => {
    expect(buildMobileAgentThreads([], NOW)).toEqual([])
    expect(buildMobileAgentThreads([worktree({ agents: undefined })], NOW)).toEqual([])
    expect(buildMobileAgentThreads([worktree({ agents: [] })], NOW)).toEqual([])
  })

  it('sorts multiple worktrees and agents by newest state timestamp first', () => {
    const threads = buildMobileAgentThreads(
      [
        worktree({
          worktreeId: 'wt-old',
          repo: 'old-repo',
          displayName: 'Old Worktree',
          agents: [agent('old', { prompt: 'old prompt', stateStartedAt: 10, updatedAt: NOW })]
        }),
        worktree({
          worktreeId: 'wt-new',
          repo: 'new-repo',
          displayName: '',
          branch: 'main',
          agents: [
            agent('middle', { prompt: 'middle prompt', stateStartedAt: 50, updatedAt: NOW }),
            agent('newest', { prompt: 'newest prompt', stateStartedAt: 100, updatedAt: NOW })
          ]
        })
      ],
      NOW
    )

    expect(threads.map((thread) => thread.agent.paneKey)).toEqual(['newest', 'middle', 'old'])
    expect(threads[0]).toMatchObject({
      worktreeId: 'wt-new',
      worktreeName: 'new-repo',
      repo: 'new-repo',
      branch: 'main',
      title: 'newest prompt',
      subtitle: 'new-repo',
      sortTimestamp: 100
    })
  })

  it('preserves flattened parent and child lineage depth in worktree groups', () => {
    const threads = buildMobileAgentThreads(
      [
        worktree({
          agents: [
            agent('root', { prompt: 'root prompt', stateStartedAt: 100, updatedAt: NOW }),
            agent('child', {
              parentPaneKey: 'root',
              prompt: 'child prompt',
              stateStartedAt: 90,
              updatedAt: NOW
            })
          ]
        })
      ],
      NOW
    )

    expect(threads.map((thread) => [thread.agent.paneKey, thread.lineageDepth])).toEqual([
      ['root', 0],
      ['child', 1]
    ])
    expect(groupMobileAgentThreads(threads, 'worktree')).toEqual([
      {
        key: 'wt-a',
        label: 'Mobile Agents',
        threads
      }
    ])
  })

  it('keeps a newer child inside its parent subtree instead of sorting it above', () => {
    const threads = buildMobileAgentThreads(
      [
        worktree({
          worktreeId: 'wt-family',
          agents: [
            agent('parent', { prompt: 'parent prompt', stateStartedAt: 100, updatedAt: NOW }),
            agent('newer-child', {
              parentPaneKey: 'parent',
              prompt: 'child prompt',
              stateStartedAt: 300,
              updatedAt: NOW
            })
          ]
        }),
        worktree({
          worktreeId: 'wt-solo',
          agents: [
            agent('solo-root', { prompt: 'solo prompt', stateStartedAt: 200, updatedAt: NOW })
          ]
        })
      ],
      NOW
    )

    // Why: roots sort newest-first (200 > 100), but the child with the newest
    // timestamp (300) must stay directly under its parent so lineageDepth
    // indentation always has its parent row rendered immediately above.
    expect(threads.map((thread) => [thread.agent.paneKey, thread.lineageDepth])).toEqual([
      ['solo-root', 0],
      ['parent', 0],
      ['newer-child', 1]
    ])
  })

  it('delegates dangling and cyclic parent handling to the lineage flattener', () => {
    const threads = buildMobileAgentThreads(
      [
        worktree({
          agents: [
            agent('dangling', { parentPaneKey: 'missing' }),
            agent('cycle-a', { parentPaneKey: 'cycle-b' }),
            agent('cycle-b', { parentPaneKey: 'cycle-a' })
          ]
        })
      ],
      NOW
    )

    expect(threads.map((thread) => thread.agent.paneKey).sort()).toEqual([
      'cycle-a',
      'cycle-b',
      'dangling'
    ])
    expect(threads.every((thread) => thread.lineageDepth === 0)).toBe(true)
  })
})

describe('filterMobileAgentThreads', () => {
  const threads = buildMobileAgentThreads(
    [
      worktree({
        repo: 'orca-mobile',
        displayName: 'Tablet Split',
        branch: 'feature/branch-search',
        agents: [
          agent('working', {
            state: 'working',
            prompt: 'Implement prompt search',
            lastAssistantMessage: 'Assistant summary match',
            toolName: 'Edit',
            toolInput: 'tool field match',
            stateStartedAt: 100,
            updatedAt: NOW
          }),
          agent('blocked', {
            state: 'blocked',
            prompt: 'Needs approval',
            stateStartedAt: 90,
            updatedAt: NOW
          }),
          agent('waiting', {
            state: 'waiting',
            prompt: 'Waiting for worker',
            stateStartedAt: 80,
            updatedAt: NOW
          }),
          agent('interrupted', {
            state: 'done',
            interrupted: true,
            prompt: 'Interrupted run',
            stateStartedAt: 70,
            updatedAt: NOW
          }),
          agent('done', {
            state: 'done',
            prompt: 'Completed run',
            stateStartedAt: 60,
            updatedAt: NOW
          }),
          agent('idle', {
            state: 'unknown-state' as never,
            prompt: 'Idle run',
            stateStartedAt: 50,
            updatedAt: NOW
          })
        ]
      })
    ],
    NOW
  )

  it('attention visibility excludes done and idle agents', () => {
    expect(
      filterMobileAgentThreads(threads, { query: '', visibility: 'attention' }).map(
        (thread) => thread.agent.paneKey
      )
    ).toEqual(['working', 'blocked', 'waiting', 'interrupted'])
  })

  it.each([
    ['prompt search', 1],
    ['assistant summary', 1],
    ['orca-mobile', 6],
    ['tablet split', 6],
    ['branch-search', 6],
    ['edit', 1],
    ['tool field', 1]
  ])('matches search text field %s', (query, expectedCount) => {
    expect(filterMobileAgentThreads(threads, { query, visibility: 'all' })).toHaveLength(
      expectedCount
    )
  })

  it('rebases an attention-matching child to depth 0 when its parent is filtered out', () => {
    const lineageThreads = buildMobileAgentThreads(
      [
        worktree({
          agents: [
            agent('done-parent', {
              state: 'done',
              prompt: 'Finished parent',
              stateStartedAt: 100,
              updatedAt: NOW
            }),
            agent('working-child', {
              parentPaneKey: 'done-parent',
              state: 'working',
              prompt: 'Active child',
              stateStartedAt: 90,
              updatedAt: NOW
            })
          ]
        })
      ],
      NOW
    )

    const filtered = filterMobileAgentThreads(lineageThreads, {
      query: '',
      visibility: 'attention'
    })
    // Why: the done parent is excluded (membership unchanged), so the retained
    // child must not render indented beneath a missing parent row.
    expect(filtered.map((thread) => [thread.agent.paneKey, thread.lineageDepth])).toEqual([
      ['working-child', 0]
    ])
    // The unfiltered threads keep their original depths.
    expect(lineageThreads.map((thread) => thread.lineageDepth)).toEqual([0, 1])
  })

  it('rebases a query-matching descendant onto its nearest retained ancestor', () => {
    const lineageThreads = buildMobileAgentThreads(
      [
        worktree({
          agents: [
            agent('root', { prompt: 'alpha shared', stateStartedAt: 100, updatedAt: NOW }),
            agent('middle', {
              parentPaneKey: 'root',
              prompt: 'unrelated middle',
              stateStartedAt: 90,
              updatedAt: NOW
            }),
            agent('grandchild', {
              parentPaneKey: 'middle',
              prompt: 'alpha shared leaf',
              stateStartedAt: 80,
              updatedAt: NOW
            })
          ]
        })
      ],
      NOW
    )

    // Only the grandchild matches: it becomes a visible root.
    expect(
      filterMobileAgentThreads(lineageThreads, { query: 'leaf', visibility: 'all' }).map(
        (thread) => [thread.agent.paneKey, thread.lineageDepth]
      )
    ).toEqual([['grandchild', 0]])

    // Root and grandchild match but the middle link does not: the grandchild
    // re-parents visually under the retained root at depth 1.
    expect(
      filterMobileAgentThreads(lineageThreads, { query: 'alpha shared', visibility: 'all' }).map(
        (thread) => [thread.agent.paneKey, thread.lineageDepth]
      )
    ).toEqual([
      ['root', 0],
      ['grandchild', 1]
    ])
  })
})

describe('groupMobileAgentThreads', () => {
  it('groups by status order, worktree, repo, and agent type while preserving row order', () => {
    const threads = buildMobileAgentThreads(
      [
        worktree({
          worktreeId: 'wt-a',
          repo: 'repo-a',
          displayName: 'Alpha',
          agents: [
            agent('done', {
              state: 'done',
              agentType: 'codex',
              stateStartedAt: 10,
              updatedAt: NOW
            }),
            agent('working', {
              state: 'working',
              agentType: 'claude',
              stateStartedAt: 50,
              updatedAt: NOW
            })
          ]
        }),
        worktree({
          worktreeId: 'wt-b',
          repo: 'repo-b',
          displayName: 'Beta',
          agents: [
            agent('blocked', {
              state: 'blocked',
              agentType: null,
              stateStartedAt: 40,
              updatedAt: NOW
            })
          ]
        })
      ],
      NOW
    )

    expect(groupMobileAgentThreads(threads, 'status').map((group) => group.key)).toEqual([
      'working',
      'blocked',
      'done'
    ])
    expect(groupMobileAgentThreads(threads, 'worktree').map((group) => group.key)).toEqual([
      'wt-a',
      'wt-b'
    ])
    expect(groupMobileAgentThreads(threads, 'repo').map((group) => group.key)).toEqual([
      'repo-a',
      'repo-b'
    ])
    expect(groupMobileAgentThreads(threads, 'agent').map((group) => group.key)).toEqual([
      'claude',
      'unknown',
      'codex'
    ])
  })
})
