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

const {
  sendMock,
  getPRForBranchOutcomeMock,
  getOriginGitHubApiRepositoryMock,
  getRateLimitMock,
  noteRepositoryRateLimitSpendMock,
  repositoryRateLimitGuardMock
} = coordinatorMocks

describe('pr-refresh-coordinator', () => {
  beforeEach(() => {
    moduleMocks.resetPRRefreshCoordinatorMocks(coordinatorMocks)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('proceeds with background refreshes when the budget probe fails (fail open)', async () => {
    const { enqueuePRRefresh } = await import('./pr-refresh-coordinator')
    // Why: regression for #7553 — GHES with rate limiting disabled 404s every
    // probe; an unreadable budget must not pause refreshes.
    getRateLimitMock.mockResolvedValue({
      ok: false,
      error: 'HTTP 404: Rate limiting is not enabled.'
    })
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'no-pr',
      fetchedAt: Date.now()
    })

    enqueuePRRefresh(makeCandidate(), 'active', 80, 1)

    await vi.advanceTimersByTimeAsync(0)

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
    const pausedEvents = sendMock.mock.calls
      .map(([, event]) => event)
      .filter((event) => event.status === 'paused' && event.skippedReason === 'rate-limit')
    expect(pausedEvents).toHaveLength(0)
  })

  it.each([
    {
      scope: 'GitHub Enterprise',
      repository: { owner: 'acme', repo: 'widgets', host: 'github.acme-corp.com' },
      repoPath: '/repo',
      localGitOptions: undefined
    },
    {
      scope: 'WSL',
      repository: { owner: 'acme', repo: 'widgets', host: 'github.com' },
      repoPath: '/repo',
      localGitOptions: { wslDistro: 'Ubuntu' }
    },
    {
      scope: 'implicit WSL UNC',
      repository: { owner: 'acme', repo: 'widgets', host: 'github.com' },
      repoPath: String.raw`\\wsl.localhost\Ubuntu\home\me\widgets`,
      localGitOptions: undefined
    }
  ])('bypasses the shared budget for $scope background refreshes', async (testCase) => {
    const { enqueuePRRefresh } = await import('./pr-refresh-coordinator')
    getOriginGitHubApiRepositoryMock.mockResolvedValue(testCase.repository)
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'no-pr',
      fetchedAt: Date.now()
    })
    const executionOptions = {
      cwd: testCase.repoPath,
      ...testCase.localGitOptions
    }

    enqueuePRRefresh(
      makeCandidate({
        repoPath: testCase.repoPath,
        localGitOptions: testCase.localGitOptions
      }),
      'active',
      80,
      1
    )

    await vi.advanceTimersByTimeAsync(0)

    expect(getRateLimitMock).not.toHaveBeenCalled()
    expect(repositoryRateLimitGuardMock).toHaveBeenCalledWith(
      testCase.repository,
      'core',
      executionOptions
    )
    expect(repositoryRateLimitGuardMock).toHaveBeenCalledWith(
      testCase.repository,
      'graphql',
      executionOptions
    )
    // Why (#11532): the lookup itself debits the snapshot now, so every caller
    // is accounted for; the coordinator must not double-charge on top.
    expect(noteRepositoryRateLimitSpendMock).not.toHaveBeenCalled()
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
  })

  it('does not consume active burst slots for rate-limit pauses', async () => {
    const { enqueuePRRefresh } = await import('./pr-refresh-coordinator')
    // Why: keyed on drained items (one getRateLimit call each) rather than
    // guard-call counts, so the guard's per-bucket evaluation order stays free
    // to change without breaking the slot-accounting assertion.
    let drainedItems = 0
    getRateLimitMock.mockImplementation(async () => {
      drainedItems += 1
      return { ok: true }
    })
    repositoryRateLimitGuardMock.mockImplementation(() =>
      drainedItems <= 3
        ? { blocked: true, remaining: 0, limit: 5000, resetAt: 61 }
        : { blocked: false }
    )
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'upstream-error',
      errorType: 'unknown',
      message: 'missing upstream',
      fetchedAt: Date.now()
    })

    for (let index = 0; index < 6; index += 1) {
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

    const pausedEvents = sendMock.mock.calls
      .map(([, event]) => event)
      .filter((event) => event.status === 'paused' && event.skippedReason === 'rate-limit')
    expect(pausedEvents).toHaveLength(3)
    expect(getPRForBranchOutcomeMock.mock.calls.map((call) => call[1])).toEqual([
      'feature/2',
      'feature/1',
      'feature/0'
    ])
  })
})
