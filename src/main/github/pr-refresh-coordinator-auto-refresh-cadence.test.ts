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

async function loadCoordinatorWithCadence(cadence: string) {
  // resetModules gives each test fresh module state; set the cadence on that same instance.
  const policy = await import('../../shared/review-refresh-policy')
  policy.setPRAutoRefreshCadence(cadence)
  return { policy, coordinator: await import('./pr-refresh-coordinator') }
}

describe('pr-refresh-coordinator auto-refresh cadence', () => {
  beforeEach(() => {
    moduleMocks.resetPRRefreshCoordinatorMocks(coordinatorMocks)
    vi.setSystemTime(1_000)
    getPRForBranchOutcomeMock.mockImplementation(async () => ({
      kind: 'found',
      pr: makePR({ checksStatus: 'pending' }),
      fetchedAt: Date.now()
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the two-minute visible follow-up by default', async () => {
    const { coordinator } = await loadCoordinatorWithCadence('default')
    coordinator.reportVisiblePRRefreshCandidates([makeCandidate()], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(2 * 60_000 + 1_000)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
  })

  it('stretches visible follow-ups to ten minutes when reduced', async () => {
    const { coordinator } = await loadCoordinatorWithCadence('reduced')
    coordinator.reportVisiblePRRefreshCandidates([makeCandidate()], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(9 * 60_000)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000 + 1_000)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
  })

  it('reads a newly visible PR once and then stops timed reads when off', async () => {
    const { coordinator } = await loadCoordinatorWithCadence('off')
    coordinator.reportVisiblePRRefreshCandidates([makeCandidate()], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
  })

  it('still reads at once on selection when off', async () => {
    const { coordinator } = await loadCoordinatorWithCadence('off')
    coordinator.enqueuePRRefresh(
      makeCandidate({
        cachedFetchedAt: Date.now(),
        cachedHasPR: true,
        cachedPRState: 'open',
        cachedChecksStatus: 'pending'
      }),
      'active',
      80
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
  })

  it('does not retry a failed visible read on a timer when off', async () => {
    const { coordinator } = await loadCoordinatorWithCadence('off')
    getPRForBranchOutcomeMock.mockImplementation(async () => ({
      kind: 'upstream-error',
      errorType: 'unknown',
      message: 'offline',
      fetchedAt: Date.now()
    }))
    coordinator.reportVisiblePRRefreshCandidates([makeCandidate()], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)

    // Selecting the workspace still reads at once.
    coordinator.enqueuePRRefresh(makeCandidate(), 'active', 80)
    await vi.advanceTimersByTimeAsync(0)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
  })

  it('retries a failed visible read no sooner than the stretched interval when reduced', async () => {
    const { coordinator } = await loadCoordinatorWithCadence('reduced')
    getPRForBranchOutcomeMock.mockImplementation(async () => ({
      kind: 'upstream-error',
      errorType: 'unknown',
      message: 'offline',
      fetchedAt: Date.now()
    }))
    coordinator.reportVisiblePRRefreshCandidates([makeCandidate()], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(9 * 60_000)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000 + 1_000)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
  })

  it('drops a queued follow-up when the cadence changes to off', async () => {
    const { policy, coordinator } = await loadCoordinatorWithCadence('default')
    coordinator.reportVisiblePRRefreshCandidates([makeCandidate()], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)

    policy.setPRAutoRefreshCadence('off')
    coordinator.retimePRRefreshesForCadence()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
  })
})
