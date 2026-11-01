import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRRefreshOutcome } from '../../shared/github/pull-request-refresh-types'

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
const { getAllWebContentsMock, getPRForBranchOutcomeMock, sendMock } = coordinatorMocks

function twoWindows(): void {
  getAllWebContentsMock.mockReturnValue([1, 2].map((id) => ({ id, isDestroyed: () => false })))
}
function found(state: 'open' | 'merged' = 'open'): PRRefreshOutcome {
  return { kind: 'found', pr: makePR({ state, checksStatus: 'success' }), fetchedAt: Date.now() }
}

describe('visibility-aware coordinator scheduling', () => {
  beforeEach(() => {
    moduleMocks.resetPRRefreshCoordinatorMocks(coordinatorMocks)
    getPRForBranchOutcomeMock.mockImplementation(async () => found())
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each([
    [true, 60_000],
    [false, 120_000]
  ] as const)('refreshes selected=%s at %s ms', async (isSelected, interval) => {
    const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
    reportVisiblePRRefreshCandidates([makeCandidate({ isSelected })], 1, 1)
    await vi.advanceTimersByTimeAsync(interval - 1)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
  })

  it('uses the strongest tier across windows and slows down when its owner hides', async () => {
    twoWindows()
    const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
    reportVisiblePRRefreshCandidates([makeCandidate()], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(20_000)
    reportVisiblePRRefreshCandidates([makeCandidate({ isSelected: true })], 1, 2)
    await vi.advanceTimersByTimeAsync(40_000)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
    reportVisiblePRRefreshCandidates([], 2, 2)
    await vi.advanceTimersByTimeAsync(119_999)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(3)
    reportVisiblePRRefreshCandidates([], 2, 1)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(3)
  })

  it('re-times a fresh cached follow-up when selected changes', async () => {
    const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
    const candidate = makeCandidate({
      cachedFetchedAt: Date.now(),
      cachedHasPR: true,
      cachedPRState: 'open'
    })
    reportVisiblePRRefreshCandidates([candidate], 1, 1)
    await vi.advanceTimersByTimeAsync(20_000)
    reportVisiblePRRefreshCandidates([{ ...candidate, isSelected: true }], 2, 1)
    await vi.advanceTimersByTimeAsync(39_999)
    expect(getPRForBranchOutcomeMock).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
  })

  it('preserves a selection change during an in-flight lookup', async () => {
    twoWindows()
    let resolve: (outcome: PRRefreshOutcome) => void = () => {}
    getPRForBranchOutcomeMock.mockImplementationOnce(
      () =>
        new Promise<PRRefreshOutcome>((done) => {
          resolve = done
        })
    )
    const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
    reportVisiblePRRefreshCandidates([makeCandidate()], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    reportVisiblePRRefreshCandidates([makeCandidate({ isSelected: true })], 1, 2)
    resolve(found())
    await vi.advanceTimersByTimeAsync(59_999)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
  })

  it('does not resurrect periodic work after every window hides during a lookup', async () => {
    let resolve: (outcome: PRRefreshOutcome) => void = () => {}
    getPRForBranchOutcomeMock.mockImplementationOnce(
      () =>
        new Promise<PRRefreshOutcome>((done) => {
          resolve = done
        })
    )
    const { reportVisiblePRRefreshCandidates, _getPRRefreshQueueSizeForTests } =
      await import('./pr-refresh-coordinator')
    reportVisiblePRRefreshCandidates([makeCandidate()], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    reportVisiblePRRefreshCandidates([], 2, 1)
    resolve(found())
    await vi.advanceTimersByTimeAsync(600_000)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
    expect(_getPRRefreshQueueSizeForTests()).toBe(0)
  })

  it('allows one settled-merged lookup on re-exposure after cooldown', async () => {
    getPRForBranchOutcomeMock.mockImplementation(async () => found('merged'))
    const { reportVisiblePRRefreshCandidates, _getPRRefreshQueueSizeForTests } =
      await import('./pr-refresh-coordinator')
    const candidate = makeCandidate()
    reportVisiblePRRefreshCandidates([candidate], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    reportVisiblePRRefreshCandidates([], 2, 1)
    const merged = makeCandidate({
      cachedFetchedAt: Date.now(),
      cachedHasPR: true,
      cachedPRState: 'merged',
      cachedChecksStatus: 'neutral'
    })
    await vi.advanceTimersByTimeAsync(9_999)
    reportVisiblePRRefreshCandidates([merged], 3, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
    reportVisiblePRRefreshCandidates([], 4, 1)
    await vi.advanceTimersByTimeAsync(1)
    reportVisiblePRRefreshCandidates([merged], 5, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
    reportVisiblePRRefreshCandidates([merged], 6, 1)
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
    expect(_getPRRefreshQueueSizeForTests()).toBe(0)
  })

  it.each(['merged', 'closed'] as const)(
    'discovers new work when a cached %s head changes',
    async (cachedPRState) => {
      const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
      reportVisiblePRRefreshCandidates(
        [
          makeCandidate({
            cachedFetchedAt: Date.now(),
            cachedHasPR: true,
            cachedPRState,
            cachedChecksStatus: 'success',
            cachedHeadOid: 'old',
            currentHeadOid: 'new'
          })
        ],
        1,
        1
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
      expect(getPRForBranchOutcomeMock.mock.calls[0][5]?.currentHeadOid).toBe('new')
      await vi.advanceTimersByTimeAsync(120_000)
      expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
    }
  )

  it('retains stale PR state and error backoff across reports and hiding', async () => {
    getPRForBranchOutcomeMock.mockImplementation(async () => ({
      kind: 'upstream-error',
      errorType: 'network',
      message: 'offline',
      fetchedAt: Date.now()
    }))
    const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
    const candidate = makeCandidate({
      cachedHasPR: true,
      cachedPRState: 'open',
      cachedHeadOid: 'old',
      currentHeadOid: 'new'
    })
    reportVisiblePRRefreshCandidates([candidate], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    reportVisiblePRRefreshCandidates([], 2, 1)
    reportVisiblePRRefreshCandidates([candidate], 3, 1)
    reportVisiblePRRefreshCandidates([{ ...candidate, isSelected: true }], 4, 1)
    await vi.advanceTimersByTimeAsync(119_999)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
    reportVisiblePRRefreshCandidates([candidate], 5, 1)
    await vi.advanceTimersByTimeAsync(119_999)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(3)
    expect(sendMock.mock.calls.map(([, event]) => event.outcome?.kind).filter(Boolean)).toEqual([
      'upstream-error',
      'upstream-error',
      'upstream-error'
    ])
  })

  it('pulls a closed follow-up forward when HEAD changes while it is queued', async () => {
    const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
    const candidate = makeCandidate({
      cachedFetchedAt: Date.now(),
      cachedHasPR: true,
      cachedPRState: 'closed',
      cachedHeadOid: 'old',
      currentHeadOid: 'old'
    })
    reportVisiblePRRefreshCandidates([candidate], 1, 1)
    await vi.advanceTimersByTimeAsync(20_000)
    reportVisiblePRRefreshCandidates([{ ...candidate, currentHeadOid: 'new' }], 2, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
    expect(getPRForBranchOutcomeMock.mock.calls[0][5]?.currentHeadOid).toBe('new')
  })

  it('keeps an in-flight head change behind the lookup failure backoff', async () => {
    let resolve: (outcome: PRRefreshOutcome) => void = () => {}
    getPRForBranchOutcomeMock.mockImplementationOnce(
      () =>
        new Promise<PRRefreshOutcome>((done) => {
          resolve = done
        })
    )
    const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
    const candidate = makeCandidate({ currentHeadOid: 'old' })
    reportVisiblePRRefreshCandidates([candidate], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    reportVisiblePRRefreshCandidates([{ ...candidate, currentHeadOid: 'new' }], 2, 1)
    resolve({
      kind: 'upstream-error',
      errorType: 'network',
      message: 'offline',
      fetchedAt: Date.now()
    })
    await vi.advanceTimersByTimeAsync(119_999)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
    expect(getPRForBranchOutcomeMock.mock.calls[1][5]?.currentHeadOid).toBe('new')
  })

  it.each([true, false])(
    'preserves a rate-limit gate across selected reports (hidden=%s)',
    async (hidden) => {
      getPRForBranchOutcomeMock.mockImplementation(async () => ({
        kind: 'upstream-error',
        errorType: 'rate_limited',
        message: 'wait',
        fetchedAt: Date.now(),
        retryDisabledUntil: 301_000
      }))
      const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
      const candidate = makeCandidate()
      reportVisiblePRRefreshCandidates([candidate], 1, 1)
      await vi.advanceTimersByTimeAsync(0)
      if (hidden) {
        reportVisiblePRRefreshCandidates([], 2, 1)
      }
      await vi.advanceTimersByTimeAsync(10_000)
      reportVisiblePRRefreshCandidates([{ ...candidate, isSelected: true }], 3, 1)
      await vi.advanceTimersByTimeAsync(289_999)
      expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
    }
  )

  it('discovers a new PR on settled-merged re-exposure and resumes selected polling', async () => {
    getPRForBranchOutcomeMock
      .mockImplementationOnce(async () => found('merged'))
      .mockImplementation(async () => ({
        kind: 'found',
        pr: makePR({ number: 13 }),
        fetchedAt: Date.now()
      }))
    const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
    reportVisiblePRRefreshCandidates([makeCandidate({ isSelected: true })], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    const merged = makeCandidate({
      isSelected: true,
      cachedFetchedAt: Date.now(),
      cachedHasPR: true,
      cachedPRState: 'merged',
      cachedChecksStatus: 'success'
    })
    reportVisiblePRRefreshCandidates([], 2, 1)
    await vi.advanceTimersByTimeAsync(120_000)
    reportVisiblePRRefreshCandidates([merged], 3, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
    expect(
      sendMock.mock.calls.map(([, event]) => event.outcome?.pr?.number).filter(Boolean)
    ).toEqual([12, 13])
    await vi.advanceTimersByTimeAsync(59_999)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(3)
  })

  it.each([
    [true, 60_000],
    [false, 900_000]
  ] as const)('discovers missing PRs at selected=%s cadence', async (isSelected, interval) => {
    getPRForBranchOutcomeMock.mockImplementation(async () => ({
      kind: 'no-pr',
      fetchedAt: Date.now()
    }))
    const { reportVisiblePRRefreshCandidates } = await import('./pr-refresh-coordinator')
    reportVisiblePRRefreshCandidates([makeCandidate({ isSelected })], 1, 1)
    await vi.advanceTimersByTimeAsync(interval - 1)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
  })
})

it('foreground exposure bypasses list spacing once while preserving cooldown and periodic budget', async () => {
  moduleMocks.resetPRRefreshCoordinatorMocks(coordinatorMocks)
  getPRForBranchOutcomeMock.mockImplementation(async () => found())
  const { reportVisiblePRRefreshCandidates, enqueuePRRefresh } =
    await import('./pr-refresh-coordinator')
  const other = makeCandidate({ branch: 'other', cacheKey: 'other', worktreeId: 'other' })
  const selected = makeCandidate({ branch: 'selected', cacheKey: 'selected', isSelected: true })
  reportVisiblePRRefreshCandidates([other, selected], 1, 1)
  await vi.advanceTimersByTimeAsync(0)
  expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
  enqueuePRRefresh(selected, 'visible', 80, 1)
  await vi.advanceTimersByTimeAsync(0)
  expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
  enqueuePRRefresh(selected, 'visible', 80, 1)
  await vi.advanceTimersByTimeAsync(9_999)
  expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
  vi.useRealTimers()
})
