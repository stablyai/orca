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

const { getPRForBranchOutcomeMock } = coordinatorMocks

describe('foreground refresh pacing', () => {
  beforeEach(() => {
    moduleMocks.resetPRRefreshCoordinatorMocks(coordinatorMocks)
    getPRForBranchOutcomeMock.mockImplementation(async () => ({
      kind: 'found',
      pr: makePR({ checksStatus: 'success' }),
      fetchedAt: Date.now()
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('limits five selected admissions to three starts until 30 seconds, including deselected queued rows', async () => {
    const { enqueuePRRefresh, reportVisiblePRRefreshCandidates } =
      await import('./pr-refresh-coordinator')
    const cards = Array.from({ length: 5 }, (_, index) =>
      makeCandidate({
        cacheKey: `/repo::feature/${index}`,
        branch: `feature/${index}`,
        worktreeId: `wt-${index}`,
        cachedPRState: 'open',
        cachedChecksStatus: 'success',
        cachedHasPR: true,
        cachedFetchedAt: Date.now()
      })
    )

    for (let index = 0; index < cards.length; index += 1) {
      const candidates = cards.map((card, cardIndex) => ({
        ...card,
        cachedFetchedAt: cardIndex === index ? null : card.cachedFetchedAt,
        isSelected: cardIndex === index
      }))
      reportVisiblePRRefreshCandidates(candidates, index + 1, 1)
      enqueuePRRefresh(candidates[index], 'visible', 80, 1)
      await vi.advanceTimersByTimeAsync(0)
    }

    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(29_999)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(getPRForBranchOutcomeMock.mock.calls.map((call) => call[1])).toEqual([
      'feature/0',
      'feature/1',
      'feature/2',
      'feature/4',
      'feature/3'
    ])
  })

  it('uses the list budget for ordinary priority-80 periodic follow-ups', async () => {
    const { enqueuePRRefresh, reportVisiblePRRefreshCandidates } =
      await import('./pr-refresh-coordinator')
    coordinatorMocks.getAllWebContentsMock.mockReturnValue(
      Array.from({ length: 5 }, (_, index) => ({ id: index + 1, isDestroyed: () => false }))
    )
    const candidates = Array.from({ length: 5 }, (_, index) =>
      makeCandidate({
        cacheKey: `/repo::feature/${index}`,
        branch: `feature/${index}`,
        worktreeId: `wt-${index}`,
        isSelected: true
      })
    )
    // Independent windows can expose different selected rows in the same runtime.
    for (const [index, candidate] of candidates.entries()) {
      reportVisiblePRRefreshCandidates([candidate], 1, index + 1)
      enqueuePRRefresh(candidate, 'visible', 80, index + 1)
    }
    await vi.advanceTimersByTimeAsync(0)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(5)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(6)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(6)
    await vi.advanceTimersByTimeAsync(1)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(7)
  })

  it('keeps the explicit manual mergeability follow-up outside the foreground burst budget', async () => {
    const { enqueuePRRefresh, refreshPRNow, reportVisiblePRRefreshCandidates } =
      await import('./pr-refresh-coordinator')
    for (let index = 0; index < 3; index += 1) {
      enqueuePRRefresh(
        makeCandidate({ branch: `active/${index}`, cacheKey: `/repo::active/${index}` }),
        'active',
        80,
        1
      )
    }
    await vi.advanceTimersByTimeAsync(0)
    const candidate = makeCandidate({ isSelected: true })
    reportVisiblePRRefreshCandidates([candidate], 1, 1)
    getPRForBranchOutcomeMock.mockResolvedValue({
      kind: 'found',
      pr: makePR({ mergeable: 'UNKNOWN' }),
      fetchedAt: Date.now()
    })
    await refreshPRNow(candidate)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(4)
    await vi.advanceTimersByTimeAsync(2_500)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(5)
  })
})
