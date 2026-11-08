import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { coordinatorMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./pr-refresh-coordinator-test-mocks')
  return { coordinatorMocks: moduleMocks.createPRRefreshCoordinatorMocks(), moduleMocks }
})

vi.mock('./pr-refresh-renderer-port', () => moduleMocks.rendererPortModuleMock(coordinatorMocks))
vi.mock('./client', () => moduleMocks.clientModuleMock(coordinatorMocks))
vi.mock('./github-api-repository', () =>
  moduleMocks.githubApiRepositoryModuleMock(coordinatorMocks)
)
vi.mock('./rate-limit', () => moduleMocks.rateLimitModuleMock(coordinatorMocks))

import { makeCandidate, makePR } from './pr-refresh-coordinator-test-harness'

const { getPRForBranchOutcomeMock } = coordinatorMocks

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

  it('stops polling settled merged PRs, including repeated visibility reports', async () => {
    const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
    getPRForBranchOutcomeMock.mockImplementation(async () => ({
      kind: 'found',
      pr: makePR({ checksStatus: 'success', state: 'merged' }),
      fetchedAt: Date.now()
    }))
    reportVisiblePRRefreshCandidates([makeCandidate()], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    const merged = makeCandidate({
      cachedFetchedAt: Date.now(),
      cachedHasPR: true,
      cachedPRState: 'merged',
      cachedChecksStatus: 'success'
    })
    await vi.advanceTimersByTimeAsync(31 * 60_000)
    reportVisiblePRRefreshCandidates([merged], 2, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000 - 31 * 60_000)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
  })
})
