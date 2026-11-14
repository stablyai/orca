import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { coordinatorMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./pr-refresh-coordinator-test-mocks')
  return { coordinatorMocks: moduleMocks.createPRRefreshCoordinatorMocks(), moduleMocks }
})

vi.mock('./pr-refresh-renderer-port', () => moduleMocks.rendererPortModuleMock(coordinatorMocks))
vi.mock('../../client/lookup/pr-for-branch-outcome', () => {
  return moduleMocks.clientModuleMock(coordinatorMocks)
})
vi.mock('../../repositories/github-api-repository-remote-probe', () => {
  return {
    getOriginGitHubApiRepository: coordinatorMocks.getOriginGitHubApiRepositoryMock
  }
})
vi.mock('../../api/rate-limit', () => moduleMocks.rateLimitModuleMock(coordinatorMocks))

import { makeCandidate, makePR } from './pr-refresh-coordinator-test-harness'

const { sendMock, getPRForBranchOutcomeMock } = coordinatorMocks

describe('pr-refresh-coordinator', () => {
  beforeEach(() => {
    moduleMocks.resetPRRefreshCoordinatorMocks(coordinatorMocks)
  })

  // Transforming the coordinator's module graph is the slow first step on a loaded machine: do it
  // once under the hook limit, so each test still imports its own fresh instance, quickly.
  beforeAll(async () => {
    await import('./pr-refresh-coordinator')
  })

  afterEach(() => {
    // A body that failed must not leave its timers to run on the next test's clock.
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('cancels queued work when a later enqueue marks the candidate invalid', async () => {
    const { enqueuePRRefresh, reportVisiblePRRefreshCandidates } =
      await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock.mockResolvedValueOnce({
      kind: 'found',
      pr: makePR({ checksStatus: 'success' }),
      fetchedAt: Date.now()
    })

    const candidate = makeCandidate()
    reportVisiblePRRefreshCandidates([candidate], 1, 1)
    await vi.advanceTimersByTimeAsync(0)

    enqueuePRRefresh(
      { ...candidate, isArchived: true, cachedFetchedAt: Date.now() },
      'active',
      80,
      1
    )
    await vi.advanceTimersByTimeAsync(10 * 60_000)

    const skippedEvents = sendMock.mock.calls
      .map(([, event]) => event)
      .filter((event) => event.status === 'skipped')

    expect(skippedEvents.at(-1)?.skippedReason).toBe('archived')
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
  })

  it('does not cancel other aliases when one coalesced PR alias becomes invalid', async () => {
    const { enqueuePRRefresh, reportVisiblePRRefreshCandidates } =
      await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ checksStatus: 'success' }),
        fetchedAt: Date.now()
      })
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ checksStatus: 'success', state: 'merged' }),
        fetchedAt: Date.now()
      })

    const first = makeCandidate({
      cacheKey: '/repo::feature/a',
      branch: 'feature/a',
      linkedPRNumber: 12,
      worktreeId: 'wt-a'
    })
    const second = makeCandidate({
      cacheKey: '/repo::feature/b',
      branch: 'feature/b',
      linkedPRNumber: 12,
      worktreeId: 'wt-b'
    })
    reportVisiblePRRefreshCandidates([first, second], 1, 1)
    await vi.advanceTimersByTimeAsync(0)

    enqueuePRRefresh({ ...first, isArchived: true, cachedFetchedAt: Date.now() }, 'active', 80, 1)
    enqueuePRRefresh({ ...second, cachedFetchedAt: Date.now() }, 'active', 80, 1)
    await vi.advanceTimersByTimeAsync(0)

    const outcomeEvents = sendMock.mock.calls
      .map(([, event]) => event)
      .filter((event) => event.outcome)

    expect(outcomeEvents.at(-1)?.aliases.map((alias) => alias.cacheKey)).toEqual([
      '/repo::feature/b'
    ])
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
  })

  it('preserves coalesced aliases across visible follow-up refreshes', async () => {
    const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ checksStatus: 'pending', mergeable: 'MERGEABLE' }),
        fetchedAt: Date.now()
      })
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ checksStatus: 'success' }),
        fetchedAt: Date.now()
      })

    reportVisiblePRRefreshCandidates(
      [
        makeCandidate({
          cacheKey: '/repo::feature/a',
          branch: 'feature/a',
          linkedPRNumber: 12,
          worktreeId: 'wt-a'
        }),
        makeCandidate({
          cacheKey: '/repo::feature/b',
          branch: 'feature/b',
          linkedPRNumber: 12,
          worktreeId: 'wt-b'
        })
      ],
      1,
      1
    )
    await vi.runOnlyPendingTimersAsync()
    await vi.advanceTimersByTimeAsync(120_000)

    const outcomeEvents = sendMock.mock.calls
      .map(([, event]) => event)
      .filter((event) => event.outcome)

    expect(outcomeEvents).toHaveLength(2)
    expect(outcomeEvents[1].aliases.map((alias) => alias.cacheKey).sort()).toEqual([
      '/repo::feature/a',
      '/repo::feature/b'
    ])
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
  })

  it('keeps a shown alias alive after its co-shown alias leaves, until the last alias leaves', async () => {
    const { reportVisiblePRRefreshCandidates, pruneWorktreePRRefreshAliases } =
      await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock.mockImplementation(async () => ({
      kind: 'found',
      pr: makePR({ checksStatus: 'pending', mergeable: 'MERGEABLE' }),
      fetchedAt: Date.now()
    }))
    const first = makeCandidate({
      cacheKey: '/repo::feature/a',
      branch: 'feature/a',
      linkedPRNumber: 12,
      worktreeId: 'wt-a',
      currentHeadOid: 'head-a'
    })
    const second = makeCandidate({
      cacheKey: '/repo::feature/b',
      branch: 'feature/b',
      linkedPRNumber: 12,
      worktreeId: 'wt-b',
      currentHeadOid: 'head-b'
    })
    reportVisiblePRRefreshCandidates([first, second], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    const outcomes = () =>
      sendMock.mock.calls.map(([, event]) => event).filter((event) => event.outcome)
    expect(outcomes()).toHaveLength(1)
    expect(outcomes()[0].aliases.map((alias) => alias.cacheKey)).toEqual([
      '/repo::feature/a',
      '/repo::feature/b'
    ])
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)

    pruneWorktreePRRefreshAliases('wt-b')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(outcomes()).toHaveLength(2)
    expect(outcomes()[1].aliases.map((alias) => alias.cacheKey)).toEqual(['/repo::feature/a'])
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)

    pruneWorktreePRRefreshAliases('wt-a')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(outcomes()).toHaveLength(2)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
  })
})
