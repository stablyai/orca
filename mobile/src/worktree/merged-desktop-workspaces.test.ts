import { describe, expect, it } from 'vitest'
import {
  executionHostFilterOptions,
  mergeDesktopWorkspaces,
  retainRepresentedExecutionHostIds,
  type DesktopWorkspaceCatalog
} from './merged-desktop-workspaces'
import { readMergedRepoCatalog, readMergedWorktreeCatalog } from './merged-desktop-catalog-response'
import { filterWorktrees } from './workspace-list-sections'
import type { FilterState, Worktree } from './workspace-list-types'

function worktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    workspaceKind: 'git',
    worktreeId: 'wt-1',
    repoId: 'repo-1',
    repo: 'orca',
    branch: 'main',
    displayName: 'main',
    path: '/tmp/wt-1',
    liveTerminalCount: 0,
    hasAttachedPty: false,
    preview: '',
    unread: false,
    isPinned: false,
    linkedPR: null,
    ...overrides
  }
}

function catalog(overrides: Partial<DesktopWorkspaceCatalog> = {}): DesktopWorkspaceCatalog {
  return {
    desktopHostId: 'macbook',
    desktopHostName: 'MacBook',
    worktrees: [worktree()],
    ...overrides
  }
}

function filters(overrides: Partial<FilterState> = {}): FilterState {
  return {
    filterRepoIds: new Set(),
    hideSleeping: false,
    hideDefaultBranch: false,
    alwaysShowDefaultBranch: true,
    ...overrides
  }
}

describe('mergeDesktopWorkspaces', () => {
  it('keeps rows from two desktops distinct when their worktree ids collide', () => {
    const merged = mergeDesktopWorkspaces([
      catalog(),
      catalog({ desktopHostId: 'desktop', desktopHostName: 'Desktop' })
    ])

    expect(merged).toHaveLength(2)
    expect(new Set(merged.map((row) => row.worktreeId)).size).toBe(2)
    expect(merged.map((row) => row.desktopWorktreeId)).toEqual(['wt-1', 'wt-1'])
    expect(merged.map((row) => row.desktopHostId)).toEqual(['macbook', 'desktop'])
    expect(new Set(merged.map((row) => row.repoId)).size).toBe(2)
  })

  it('keeps delimiter-bearing desktop and local id tuples distinct', () => {
    const merged = mergeDesktopWorkspaces([
      catalog({
        desktopHostId: 'a::b',
        worktrees: [worktree({ worktreeId: 'c', repoId: 'c' })]
      }),
      catalog({
        desktopHostId: 'a',
        worktrees: [worktree({ worktreeId: 'b::c', repoId: 'b::c' })]
      })
    ])

    expect(new Set(merged.map((row) => row.worktreeId)).size).toBe(2)
    expect(new Set(merged.map((row) => row.repoId)).size).toBe(2)
  })

  it('rewrites lineage links inside the same desktop so a parent still resolves', () => {
    const merged = mergeDesktopWorkspaces([
      catalog({
        worktrees: [
          worktree({ worktreeId: 'parent', childWorktreeIds: ['child'] }),
          worktree({ worktreeId: 'child', parentWorktreeId: 'parent' })
        ]
      })
    ])

    const child = merged.find((row) => row.desktopWorktreeId === 'child')
    expect(child?.parentWorktreeId).toBe(merged[0]?.worktreeId)
    expect(merged[0]?.childWorktreeIds).toEqual([child?.worktreeId])
  })

  it('leaves a root workspace parentless instead of namespacing null', () => {
    const merged = mergeDesktopWorkspaces([catalog()])
    expect(merged[0]?.parentWorktreeId).toBeNull()
  })

  it('resolves the execution host from the repo when the payload omits hostId', () => {
    const merged = mergeDesktopWorkspaces([
      catalog({
        worktrees: [worktree({ repoId: 'repo-ssh' }), worktree({ worktreeId: 'wt-2' })],
        repos: [
          { id: 'repo-ssh', displayName: 'orca', executionHostId: 'ssh:gpu-box' },
          { id: 'repo-1', displayName: 'orca' }
        ]
      })
    ])

    expect(merged[0]?.hostId).toBe('ssh:gpu-box')
    expect(merged[1]?.hostId).toBe('local')
  })

  it('prefers the worktree hostId over the repo fallback', () => {
    const merged = mergeDesktopWorkspaces([
      catalog({
        worktrees: [worktree({ hostId: 'runtime:node-a', repoId: 'repo-ssh' })],
        repos: [{ id: 'repo-ssh', displayName: 'orca', executionHostId: 'ssh:gpu-box' }]
      })
    ])

    expect(merged[0]?.hostId).toBe('runtime:node-a')
  })

  it('keeps equal execution-host ids distinct across paired desktops', () => {
    const merged = mergeDesktopWorkspaces([
      catalog({
        desktopHostId: 'laptop',
        desktopHostName: 'Laptop',
        worktrees: [worktree({ hostId: 'ssh:gpu-box' })]
      }),
      catalog({
        desktopHostId: 'tower',
        desktopHostName: 'Tower',
        worktrees: [worktree({ hostId: 'ssh:gpu-box' })]
      })
    ])
    const options = executionHostFilterOptions(merged)

    expect(new Set(options.map((option) => option.id)).size).toBe(2)
    expect(options.map((option) => option.label).sort()).toEqual([
      'Laptop · gpu-box',
      'Tower · gpu-box'
    ])
    const kept = filterWorktrees(
      merged,
      filters({ filterExecutionHostIds: new Set([options[0]!.id]) }),
      ''
    )
    expect(kept.map((row) => row.desktopHostId)).toEqual([
      options[0]!.label.startsWith('Laptop') ? 'laptop' : 'tower'
    ])
  })

  it('does not guess local ownership for a legacy folder row with no host metadata', () => {
    const merged = mergeDesktopWorkspaces([
      catalog({
        worktrees: [
          worktree({ workspaceKind: 'folder-workspace', repoId: 'folder-workspace:group-1' })
        ],
        repos: []
      })
    ])

    expect(merged[0]?.hostId).toBeUndefined()
    expect(executionHostFilterOptions(merged)[0]?.label).toBe('MacBook · Unknown host')
  })
})

describe('merged catalog response validation', () => {
  it('rejects malformed success payloads and invalid explicit host ids', () => {
    expect(readMergedWorktreeCatalog({})).toBeNull()
    expect(
      readMergedWorktreeCatalog({ worktrees: [worktree({ hostId: 'ssh:' as never })] })
    ).toBeNull()
    expect(
      readMergedRepoCatalog({
        repos: [{ id: 'repo', displayName: 'Repo', executionHostId: 'ssh:' }]
      })
    ).toBeNull()
  })

  it('normalizes safe repo decorations and rejects unsafe color and icon sinks', () => {
    expect(
      readMergedRepoCatalog({
        repos: [
          {
            id: 'repo',
            displayName: 'Repo',
            badgeColor: ' ABC ',
            repoIcon: { type: 'emoji', emoji: ' 🚀 ' }
          }
        ]
      })
    ).toEqual([
      {
        id: 'repo',
        displayName: 'Repo',
        badgeColor: '#aabbcc',
        repoIcon: { type: 'emoji', emoji: '🚀' }
      }
    ])
    expect(
      readMergedRepoCatalog({
        repos: [{ id: 'repo', displayName: 'Repo', badgeColor: 'url(javascript:alert(1))' }]
      })
    ).toBeNull()
    expect(
      readMergedRepoCatalog({
        repos: [
          {
            id: 'repo',
            displayName: 'Repo',
            repoIcon: { type: 'image', source: 'favicon', src: 'http://example.test/icon.png' }
          }
        ]
      })
    ).toBeNull()
    expect(
      readMergedRepoCatalog({
        repos: [
          {
            id: 'repo',
            displayName: 'Repo',
            repoIcon: { type: 'emoji', emoji: '🚀'.repeat(17) }
          }
        ]
      })
    ).toBeNull()
  })

  it('accepts legacy rows that omit hostId', () => {
    expect(readMergedWorktreeCatalog({ worktrees: [worktree()] })).toEqual([worktree()])
  })

  it('rejects malformed linked pull requests and agent rows', () => {
    expect(
      readMergedWorktreeCatalog({
        worktrees: [worktree({ linkedPR: { number: '12', state: 'open' } as never })]
      })
    ).toBeNull()
    expect(
      readMergedWorktreeCatalog({
        worktrees: [
          worktree({
            agents: [
              {
                paneKey: 'pane-1',
                parentPaneKey: null,
                state: 'working',
                agentType: 'codex',
                prompt: 'Review',
                taskTitle: null,
                displayName: null,
                lastAssistantMessage: null,
                toolName: null,
                toolInput: null,
                interrupted: false,
                stateStartedAt: 1,
                updatedAt: 'now'
              } as never
            ]
          })
        ]
      })
    ).toBeNull()
  })
})

describe('executionHostFilterOptions', () => {
  it('offers only represented hosts, most populated first', () => {
    const options = executionHostFilterOptions([
      worktree({ hostId: 'ssh:gpu-box' }),
      worktree({ hostId: 'ssh:gpu-box' }),
      worktree({})
    ])

    expect(options.map((option) => option.id)).toEqual(['ssh:gpu-box', 'local'])
    expect(options[0]?.count).toBe(2)
    expect(options[0]?.label).toBe('gpu-box')
  })
})

describe('retainRepresentedExecutionHostIds', () => {
  it('drops a selection whose host disappeared so the list cannot stay empty', () => {
    const options = executionHostFilterOptions([worktree({ hostId: 'ssh:gpu-box' })])
    const retained = retainRepresentedExecutionHostIds(
      new Set(['ssh:gpu-box', 'ssh:retired'] as const),
      options
    )

    expect([...retained]).toEqual(['ssh:gpu-box'])
  })
})

describe('filterWorktrees execution host filter', () => {
  it('keeps only the selected hosts', () => {
    const rows = [
      worktree({ worktreeId: 'a', hostId: 'ssh:gpu-box' }),
      worktree({ worktreeId: 'b', hostId: 'local' })
    ]

    const kept = filterWorktrees(
      rows,
      filters({ filterExecutionHostIds: new Set(['ssh:gpu-box'] as const) }),
      ''
    )

    expect(kept.map((row) => row.worktreeId)).toEqual(['a'])
  })

  it('treats an absent hostId as local so older host payloads stay visible', () => {
    const rows = [worktree({ worktreeId: 'legacy' })]

    const kept = filterWorktrees(
      rows,
      filters({ filterExecutionHostIds: new Set(['local'] as const) }),
      ''
    )

    expect(kept.map((row) => row.worktreeId)).toEqual(['legacy'])
  })

  it('is a no-op when nothing is selected', () => {
    const rows = [worktree({ hostId: 'ssh:gpu-box' })]
    expect(filterWorktrees(rows, filters({ filterExecutionHostIds: new Set() }), '')).toHaveLength(
      1
    )
  })
})
