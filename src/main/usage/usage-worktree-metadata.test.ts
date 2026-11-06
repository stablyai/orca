import { describe, expect, it, vi } from 'vitest'
import { loadKnownUsageWorktreesByRepo } from './usage-worktree-metadata'

describe('loadKnownUsageWorktreesByRepo', () => {
  it('builds usage worktree refs from repo roots and persisted metadata', () => {
    const store = {
      getAllWorktreeMeta: vi.fn(() => ({
        'repo-1::/workspace/repo-a-feature': {
          displayName: 'Feature A'
        },
        'repo-2::/remote/repo-b-feature': {
          displayName: 'Remote feature'
        },
        malformed: {
          displayName: 'Ignored'
        }
      }))
    }
    const repos = [
      {
        id: 'repo-1',
        path: '/workspace/repo-a',
        displayName: 'Repo A'
      },
      {
        id: 'repo-2',
        path: '/remote/repo-b',
        displayName: 'Remote Repo',
        connectionId: 'ssh-1'
      }
    ]

    expect(loadKnownUsageWorktreesByRepo(store as never, repos as never)).toEqual(
      new Map([
        [
          'repo-1',
          [
            {
              worktreeId: 'repo-1::/workspace/repo-a',
              path: '/workspace/repo-a',
              displayName: 'Repo A'
            },
            {
              worktreeId: 'repo-1::/workspace/repo-a-feature',
              path: '/workspace/repo-a-feature',
              displayName: 'Feature A'
            }
          ]
        ]
      ])
    )
    expect(store.getAllWorktreeMeta).toHaveBeenCalledTimes(1)
  })

  it('indexes repos once for many persisted worktrees', () => {
    const repoCount = 200
    let repoIdReads = 0
    const repos = Array.from({ length: repoCount }, (_, index) => ({
      get id() {
        repoIdReads += 1
        return `repo-${index}`
      },
      path: `/workspace/repo-${index}`,
      displayName: `Repo ${index}`
    }))
    const worktreeMeta = Object.fromEntries(
      Array.from({ length: repoCount }, (_, offset) => {
        const index = repoCount - offset - 1
        return [
          `repo-${index}::/workspace/repo-${index}-feature`,
          { displayName: `Feature ${index}` }
        ]
      })
    )

    const result = loadKnownUsageWorktreesByRepo(
      { getAllWorktreeMeta: () => worktreeMeta } as never,
      repos as never
    )

    expect(result.size).toBe(repoCount)
    expect([...result.values()].every((worktrees) => worktrees.length === 2)).toBe(true)
    expect(repoIdReads).toBeLessThanOrEqual(repoCount * 4)
  })
})
