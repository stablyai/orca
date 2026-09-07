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

import { makeCandidate, makePR } from './pr-refresh-coordinator-test-harness'

const { getAllWebContentsMock, getPRForBranchOutcomeMock } = coordinatorMocks

describe('pr-refresh-coordinator', () => {
  beforeEach(() => {
    moduleMocks.resetPRRefreshCoordinatorMocks(coordinatorMocks)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('clears visible follow-ups when the owning window is destroyed', async () => {
    const {
      _getVisiblePRRefreshWindowCountForTests,
      clearVisiblePRRefreshWindow,
      reportVisiblePRRefreshCandidates
    } = await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'found',
      pr: makePR({ checksStatus: 'pending', mergeable: 'MERGEABLE' }),
      fetchedAt: Date.now()
    })

    reportVisiblePRRefreshCandidates([makeCandidate()], 1, 1)
    await vi.runOnlyPendingTimersAsync()

    expect(_getVisiblePRRefreshWindowCountForTests()).toBe(1)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)

    clearVisiblePRRefreshWindow(1)
    await vi.advanceTimersByTimeAsync(90_000)

    expect(_getVisiblePRRefreshWindowCountForTests()).toBe(0)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
  })

  it('clears visible retry backoff when a non-visible manual refresh steals the retry', async () => {
    const {
      _getPRRefreshErrorBackoffCountForTests,
      refreshPRNow,
      reportVisiblePRRefreshCandidates
    } = await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock
      .mockResolvedValueOnce({
        kind: 'upstream-error',
        errorType: 'network',
        message: 'network down',
        fetchedAt: Date.now()
      })
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ checksStatus: 'success' }),
        fetchedAt: Date.now()
      })

    const candidate = makeCandidate()
    reportVisiblePRRefreshCandidates([candidate], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(_getPRRefreshErrorBackoffCountForTests()).toBe(1)

    getAllWebContentsMock.mockReturnValue([])
    await refreshPRNow(candidate)

    expect(_getPRRefreshErrorBackoffCountForTests()).toBe(0)
  })

  it('retries visible PRs with unknown mergeability before the success-check interval', async () => {
    const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ checksStatus: 'success', mergeable: 'UNKNOWN' }),
        fetchedAt: Date.now()
      })
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ checksStatus: 'success', mergeable: 'MERGEABLE' }),
        fetchedAt: Date.now()
      })

    reportVisiblePRRefreshCandidates([makeCandidate()], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(9_999)

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1)

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
  })

  it('does a prompt visible follow-up after a manual refresh returns unknown mergeability', async () => {
    const { refreshPRNow, reportVisiblePRRefreshCandidates } =
      await import('./pr-refresh-coordinator')
    const visibleCandidate = makeCandidate()
    const candidate = makeCandidate({
      cachedFetchedAt: Date.now(),
      cachedHasPR: true,
      cachedPRState: 'open',
      cachedChecksStatus: 'success',
      cachedMergeable: 'MERGEABLE',
      cachedMergeStateStatus: 'CLEAN'
    })
    getPRForBranchOutcomeMock
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ checksStatus: 'success', mergeable: 'MERGEABLE' }),
        fetchedAt: Date.now()
      })
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ checksStatus: 'success', mergeable: 'UNKNOWN' }),
        fetchedAt: Date.now()
      })
      .mockResolvedValueOnce({
        kind: 'found',
        pr: makePR({ checksStatus: 'success', mergeable: 'CONFLICTING' }),
        fetchedAt: Date.now()
      })

    reportVisiblePRRefreshCandidates([visibleCandidate], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    await refreshPRNow(candidate)

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(2_499)

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(1)

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(3)
  })
})
