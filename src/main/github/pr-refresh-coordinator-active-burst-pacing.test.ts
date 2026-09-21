import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { coordinatorMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./pr-refresh-coordinator-test-mocks')
  return { coordinatorMocks: moduleMocks.createPRRefreshCoordinatorMocks(), moduleMocks }
})

vi.mock('electron', () => moduleMocks.electronModuleMock(coordinatorMocks))
vi.mock('./client', () => moduleMocks.clientModuleMock(coordinatorMocks))
vi.mock('./github-api-repository', () =>
  moduleMocks.githubApiRepositoryModuleMock(coordinatorMocks)
)
vi.mock('./rate-limit', () => moduleMocks.rateLimitModuleMock(coordinatorMocks))
vi.mock('../ipc/ui', () => moduleMocks.ipcUiModuleMock(coordinatorMocks))

import { makeCandidate } from './pr-refresh-coordinator-test-harness'

const { sendMock, getPRForBranchOutcomeMock } = coordinatorMocks

describe('pr-refresh-coordinator', () => {
  beforeEach(() => {
    moduleMocks.resetPRRefreshCoordinatorMocks(coordinatorMocks)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('paces a burst of distinct active refreshes', async () => {
    const { enqueuePRRefresh } = await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'upstream-error',
      errorType: 'unknown',
      message: 'missing upstream',
      fetchedAt: Date.now()
    })

    for (let index = 0; index < 10; index += 1) {
      enqueuePRRefresh(
        makeCandidate({
          cacheKey: `/repo::feature/${index}`,
          branch: `feature/${index}`,
          worktreeId: `wt-${index}`
        }),
        'active',
        80,
        1
      )
    }

    await vi.advanceTimersByTimeAsync(0)

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(3)
    expect(
      getPRForBranchOutcomeMock.mock.calls.map(([repoPath, branch]) => [repoPath, branch])
    ).toEqual([
      ['/repo', 'feature/9'],
      ['/repo', 'feature/8'],
      ['/repo', 'feature/7']
    ])

    await vi.advanceTimersByTimeAsync(29_999)

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(3)
    expect(
      sendMock.mock.calls
        .map(([, event]) => event)
        .some((event) => event.reason === 'active' && event.status === 'queued')
    ).toBe(true)

    await vi.advanceTimersByTimeAsync(1)

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(6)
  })

  it('treats a same-key active reactivation as the latest active signal', async () => {
    const { enqueuePRRefresh } = await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'upstream-error',
      errorType: 'unknown',
      message: 'missing upstream',
      fetchedAt: Date.now()
    })

    for (let index = 0; index < 10; index += 1) {
      enqueuePRRefresh(
        makeCandidate({
          cacheKey: `/repo::feature/${index}`,
          branch: `feature/${index}`,
          worktreeId: `wt-${index}`
        }),
        'active',
        80,
        1
      )
    }
    await vi.advanceTimersByTimeAsync(0)

    enqueuePRRefresh(
      makeCandidate({
        cacheKey: '/repo::feature/0',
        branch: 'feature/0',
        worktreeId: 'wt-0'
      }),
      'active',
      80,
      1
    )
    await vi.advanceTimersByTimeAsync(30_000)

    expect(getPRForBranchOutcomeMock.mock.calls[3]?.[1]).toBe('feature/0')
  })

  it('does not let one capped active window block another window', async () => {
    const { enqueuePRRefresh } = await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'upstream-error',
      errorType: 'unknown',
      message: 'missing upstream',
      fetchedAt: Date.now()
    })

    for (let index = 0; index < 10; index += 1) {
      enqueuePRRefresh(
        makeCandidate({
          cacheKey: `/repo::feature/${index}`,
          branch: `feature/${index}`,
          worktreeId: `wt-${index}`
        }),
        'active',
        80,
        1
      )
    }
    enqueuePRRefresh(
      makeCandidate({
        cacheKey: '/repo::feature/other-window',
        branch: 'feature/other-window',
        worktreeId: 'wt-other-window'
      }),
      'active',
      80,
      2
    )

    await vi.advanceTimersByTimeAsync(0)

    expect(getPRForBranchOutcomeMock.mock.calls.map((call) => call[1])).toContain(
      'feature/other-window'
    )
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(4)
  })

  it('does not let capped host active work block WSL or SSH active scopes', async () => {
    const { enqueuePRRefresh } = await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'upstream-error',
      errorType: 'unknown',
      message: 'missing upstream',
      fetchedAt: Date.now()
    })

    for (let index = 0; index < 10; index += 1) {
      enqueuePRRefresh(
        makeCandidate({
          cacheKey: `/repo::feature/${index}`,
          branch: `feature/${index}`,
          worktreeId: `wt-${index}`
        }),
        'active',
        80,
        1
      )
    }
    enqueuePRRefresh(
      makeCandidate({
        cacheKey: 'wsl::repo-1::feature/wsl',
        branch: 'feature/wsl',
        localGitOptions: { wslDistro: 'Ubuntu' },
        worktreeId: 'wt-wsl'
      }),
      'active',
      80,
      1
    )
    enqueuePRRefresh(
      makeCandidate({
        cacheKey: 'ssh:ssh-1::repo-1::feature/ssh',
        branch: 'feature/ssh',
        connectionId: 'ssh-1',
        worktreeId: 'wt-ssh'
      }),
      'active',
      80,
      1
    )

    await vi.advanceTimersByTimeAsync(0)

    const startedBranches = getPRForBranchOutcomeMock.mock.calls.map((call) => call[1])
    expect(startedBranches).toContain('feature/wsl')
    expect(startedBranches).toContain('feature/ssh')
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(5)
  })

  it('does not let a capped active scope block ready visible work', async () => {
    const { enqueuePRRefresh, reportVisiblePRRefreshCandidates } =
      await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'upstream-error',
      errorType: 'unknown',
      message: 'missing upstream',
      fetchedAt: Date.now()
    })

    for (let index = 0; index < 10; index += 1) {
      enqueuePRRefresh(
        makeCandidate({
          cacheKey: `/repo::feature/${index}`,
          branch: `feature/${index}`,
          worktreeId: `wt-${index}`
        }),
        'active',
        80,
        1
      )
    }
    reportVisiblePRRefreshCandidates(
      [
        makeCandidate({
          cacheKey: '/repo::feature/visible',
          branch: 'feature/visible',
          worktreeId: 'wt-visible'
        })
      ],
      1,
      1
    )

    await vi.advanceTimersByTimeAsync(0)

    expect(getPRForBranchOutcomeMock.mock.calls.map((call) => call[1])).toContain('feature/visible')
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(4)
  })

  it('wakes for visible budget spacing before a capped active burst opens', async () => {
    const { enqueuePRRefresh, reportVisiblePRRefreshCandidates } =
      await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'upstream-error',
      errorType: 'unknown',
      message: 'missing upstream',
      fetchedAt: Date.now()
    })

    reportVisiblePRRefreshCandidates(
      [
        makeCandidate({
          cacheKey: '/repo::feature/visible-first',
          branch: 'feature/visible-first',
          worktreeId: 'wt-visible-first'
        })
      ],
      1,
      1
    )
    await vi.advanceTimersByTimeAsync(0)

    for (let index = 0; index < 10; index += 1) {
      enqueuePRRefresh(
        makeCandidate({
          cacheKey: `/repo::feature/${index}`,
          branch: `feature/${index}`,
          worktreeId: `wt-${index}`
        }),
        'active',
        80,
        1
      )
    }
    reportVisiblePRRefreshCandidates(
      [
        makeCandidate({
          cacheKey: '/repo::feature/visible-second',
          branch: 'feature/visible-second',
          worktreeId: 'wt-visible-second'
        })
      ],
      2,
      1
    )

    await vi.advanceTimersByTimeAsync(0)

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(4)

    await vi.advanceTimersByTimeAsync(9_999)

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(4)

    await vi.advanceTimersByTimeAsync(1)

    expect(getPRForBranchOutcomeMock.mock.calls.map((call) => call[1])).toContain(
      'feature/visible-second'
    )
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(5)
  })
})
