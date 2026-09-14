import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = await vi.hoisted(async () => {
  const { createGitHubIpcMocks } = await import('./github-ipc-module-mocks')
  return createGitHubIpcMocks()
})

vi.mock('electron', () => mocks.electron)
vi.mock('../github/client', () => mocks.client)
vi.mock('../github/work-item-details', () => mocks.workItemDetails)
vi.mock('../github/pr-refresh-coordinator', () => mocks.prRefresh)
vi.mock('../telemetry/client', () => mocks.telemetry)
vi.mock('../telemetry/cohort-classifier', () => mocks.cohort)
vi.mock('./ui', () => mocks.ui)

import { registerGitHubHandlers } from './github'
import { createGitHubIpcHarness } from './github-ipc-test-harness'

const {
  enqueuePRRefresh: enqueuePRRefreshMock,
  refreshPRNow: refreshPRNowMock,
  reportVisiblePRRefreshCandidates: reportVisiblePRRefreshCandidatesMock
} = mocks.prRefresh

describe('registerGitHubHandlers', () => {
  const harness = createGitHubIpcHarness(mocks)
  const { handlers, store, stats } = harness

  beforeEach(harness.reset)

  it('returns typed automatic PR refresh validation skips without enqueueing', async () => {
    registerGitHubHandlers(store as never, stats as never)
    const candidate = {
      cacheKey: 'missing::feature/test',
      repoPath: '/workspace/missing',
      repoId: 'missing-repo',
      branch: 'feature/test',
      repoKind: 'git' as const
    }

    const first = await handlers['gh:enqueuePRRefresh'](null, {
      candidate,
      reason: 'active',
      priority: 80
    })
    const second = await handlers['gh:enqueuePRRefresh'](null, {
      candidate,
      reason: 'active',
      priority: 80
    })

    expect(first).toEqual({ kind: 'skipped', skippedReason: 'validation-denied' })
    expect(second).toEqual({ kind: 'skipped', skippedReason: 'validation-backoff' })
    expect(first).not.toBe(false)
    expect(second).not.toBe(false)
    expect(enqueuePRRefreshMock).not.toHaveBeenCalled()
  })

  it('uses registered repo routing fields for automatic PR refresh candidates', async () => {
    harness.repos = [
      {
        id: 'repo-ssh',
        path: '/workspace/remote-repo',
        displayName: 'repo',
        badgeColor: '#000',
        addedAt: 0,
        connectionId: 'ssh-real',
        executionHostId: 'ssh:ssh-real'
      }
    ]
    registerGitHubHandlers(store as never, stats as never)

    await handlers['gh:enqueuePRRefresh'](null, {
      candidate: {
        cacheKey: 'remote::feature/test',
        repoPath: '/workspace/remote-repo',
        repoId: 'repo-ssh',
        branch: 'feature/test',
        repoKind: 'git',
        connectionId: 'ssh-stale',
        executionHostId: 'runtime:stale',
        connectionState: 'disconnected',
        localGitOptions: { wslDistro: 'Stale' }
      },
      reason: 'active',
      priority: 80
    })

    const candidate = enqueuePRRefreshMock.mock.calls[0]?.[0]
    expect(candidate).toEqual(
      expect.objectContaining({
        repoPath: '/workspace/remote-repo',
        repoId: 'repo-ssh',
        connectionId: 'ssh-real',
        executionHostId: 'ssh:ssh-real',
        connectionState: 'connected'
      })
    )
    expect(candidate).not.toHaveProperty('localGitOptions')
  })

  it('keeps manual PR refresh validation strict', async () => {
    registerGitHubHandlers(store as never, stats as never)

    await expect(
      handlers['gh:refreshPRNow'](null, {
        candidate: {
          cacheKey: 'missing::feature/test',
          repoPath: '/workspace/missing',
          repoId: 'missing-repo',
          branch: 'feature/test',
          repoKind: 'git'
        }
      })
    ).rejects.toThrow('Access denied: unknown repository path')

    expect(refreshPRNowMock).not.toHaveBeenCalled()
  })

  it('skips stale visible PR refresh candidates without rejecting the batch', async () => {
    registerGitHubHandlers(store as never, stats as never)

    expect(
      handlers['gh:reportVisiblePRRefreshCandidates'](
        { sender: { id: 7, once: vi.fn() } },
        {
          generation: 1,
          candidates: [
            {
              cacheKey: '/workspace/repo::feature/live',
              repoPath: '/workspace/repo',
              branch: 'feature/live',
              repoKind: 'git',
              repoId: 'repo-1'
            },
            {
              cacheKey: '/workspace/missing::feature/stale',
              repoPath: '/workspace/missing',
              branch: 'feature/stale',
              repoKind: 'git',
              repoId: 'repo-missing'
            }
          ]
        }
      )
    ).toBe(true)

    expect(reportVisiblePRRefreshCandidatesMock).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          repoPath: '/workspace/repo',
          repoId: 'repo-1',
          branch: 'feature/live'
        })
      ],
      1,
      7
    )
  })

  it('clears a sender visible PR refresh set when all current candidates are invalid', async () => {
    registerGitHubHandlers(store as never, stats as never)

    await handlers['gh:reportVisiblePRRefreshCandidates'](
      { sender: { id: 8, once: vi.fn() } },
      {
        generation: 2,
        candidates: [
          {
            cacheKey: 'missing::feature/old',
            repoPath: '/workspace/missing',
            repoId: 'missing-repo',
            branch: 'feature/old',
            repoKind: 'git'
          }
        ]
      }
    )

    expect(reportVisiblePRRefreshCandidatesMock).toHaveBeenCalledWith([], 2, 8)
  })
})
