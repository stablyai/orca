import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRRefreshOutcome } from '../../shared/github/pull-request-refresh-types'

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
const { getPRForBranchOutcomeMock, sendMock } = coordinatorMocks
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
})
