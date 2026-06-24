import { describe, expect, it, vi } from 'vitest'
import { makeWorktreeKey } from '../shared/worktree-id'
import { getUsageRepoKey, loadKnownUsageWorktreesByRepo } from './usage-worktree-metadata'

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
          getUsageRepoKey({ id: 'repo-1', connectionId: null, executionHostId: null }),
          [
            {
              worktreeId: makeWorktreeKey({
                hostId: 'local',
                repoId: 'repo-1',
                path: '/workspace/repo-a'
              }),
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

  it('keeps same-id local and runtime repos in separate usage buckets', () => {
    const store = {
      getAllWorktreeMeta: vi.fn(() => ({
        [makeWorktreeKey({
          hostId: 'local',
          repoId: 'repo-1',
          path: '/workspace/local-feature'
        })]: {
          displayName: 'Local feature'
        },
        [makeWorktreeKey({
          hostId: 'runtime:server-1',
          repoId: 'repo-1',
          path: '/srv/runtime-feature'
        })]: {
          displayName: 'Runtime feature'
        }
      }))
    }
    const localRepo = {
      id: 'repo-1',
      path: '/workspace/repo-a',
      displayName: 'Local Repo'
    }
    const runtimeRepo = {
      id: 'repo-1',
      path: '/srv/repo-a',
      displayName: 'Runtime Repo',
      executionHostId: 'runtime:server-1' as const
    }

    const result = loadKnownUsageWorktreesByRepo(store as never, [localRepo, runtimeRepo] as never)

    expect(result.get(getUsageRepoKey(localRepo))).toEqual([
      {
        worktreeId: makeWorktreeKey({
          hostId: 'local',
          repoId: 'repo-1',
          path: '/workspace/repo-a'
        }),
        path: '/workspace/repo-a',
        displayName: 'Local Repo'
      },
      {
        worktreeId: makeWorktreeKey({
          hostId: 'local',
          repoId: 'repo-1',
          path: '/workspace/local-feature'
        }),
        path: '/workspace/local-feature',
        displayName: 'Local feature'
      }
    ])
    expect(result.get(getUsageRepoKey(runtimeRepo))).toEqual([
      {
        worktreeId: makeWorktreeKey({
          hostId: 'runtime:server-1',
          repoId: 'repo-1',
          path: '/srv/repo-a'
        }),
        path: '/srv/repo-a',
        displayName: 'Runtime Repo'
      },
      {
        worktreeId: makeWorktreeKey({
          hostId: 'runtime:server-1',
          repoId: 'repo-1',
          path: '/srv/runtime-feature'
        }),
        path: '/srv/runtime-feature',
        displayName: 'Runtime feature'
      }
    ])
  })
})
