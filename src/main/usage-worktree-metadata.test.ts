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
})
