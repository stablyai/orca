import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { coordinatorMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./pr-refresh-coordinator-test-mocks')
  return { coordinatorMocks: moduleMocks.createPRRefreshCoordinatorMocks(), moduleMocks }
})

vi.mock('./pr-refresh-renderer-port', () => moduleMocks.rendererPortModuleMock(coordinatorMocks))
vi.mock('../../client/lookup/pr-for-branch-outcome', () =>
  moduleMocks.clientModuleMock(coordinatorMocks)
)
vi.mock('../../repositories/github-api-repository-remote-probe', () => ({
  getOriginGitHubApiRepository: coordinatorMocks.getOriginGitHubApiRepositoryMock
}))
vi.mock('../../api/rate-limit', () => moduleMocks.rateLimitModuleMock(coordinatorMocks))

import { makeCandidate, makePR } from './pr-refresh-coordinator-test-harness'

const { getPRForBranchOutcomeMock } = coordinatorMocks

async function loadCoordinatorWithCadence(cadence: string) {
  // resetModules gives each test fresh module state; set the cadence on that same instance.
  const policy = await import('../../../../shared/review-refresh-policy')
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

  it('drops a queued follow-up when the cadence changes to off, and resumes on Default without a new report', async () => {
    const { policy, coordinator } = await loadCoordinatorWithCadence('default')
    coordinator.reportVisiblePRRefreshCandidates([makeCandidate()], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)

    policy.setPRAutoRefreshCadence('off')
    coordinator.retimePRRefreshesForCadence()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)

    policy.setPRAutoRefreshCadence('default')
    coordinator.retimePRRefreshesForCadence()
    await vi.advanceTimersByTimeAsync(0)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
  })

  it('drops an error retry that was already queued when the cadence changes to off, and restores it on Default', async () => {
    const { policy, coordinator } = await loadCoordinatorWithCadence('default')
    getPRForBranchOutcomeMock.mockImplementation(async () => ({
      kind: 'upstream-error',
      errorType: 'unknown',
      message: 'offline',
      fetchedAt: Date.now()
    }))
    coordinator.reportVisiblePRRefreshCandidates([makeCandidate()], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)

    policy.setPRAutoRefreshCadence('off')
    coordinator.retimePRRefreshesForCadence()
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)

    // Selecting the workspace still reads at once.
    coordinator.enqueuePRRefresh(makeCandidate(), 'active', 80)
    await vi.advanceTimersByTimeAsync(0)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)

    // Back on Default the failed row is retried on its own, once its retry time has passed.
    policy.setPRAutoRefreshCadence('default')
    coordinator.retimePRRefreshesForCadence()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(getPRForBranchOutcomeMock.mock.calls.length).toBeGreaterThan(2)
  })

  it('moves an already queued error retry to the stretched interval when the cadence changes to reduced', async () => {
    const { policy, coordinator } = await loadCoordinatorWithCadence('default')
    getPRForBranchOutcomeMock.mockImplementation(async () => ({
      kind: 'upstream-error',
      errorType: 'unknown',
      message: 'offline',
      fetchedAt: Date.now()
    }))
    coordinator.reportVisiblePRRefreshCandidates([makeCandidate()], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)

    policy.setPRAutoRefreshCadence('reduced')
    coordinator.retimePRRefreshesForCadence()
    await vi.advanceTimersByTimeAsync(9 * 60_000)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000 + 1_000)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
  })

  it('moves an already queued error retry back to the default interval when the cadence returns to default', async () => {
    const { policy, coordinator } = await loadCoordinatorWithCadence('minimal')
    getPRForBranchOutcomeMock.mockImplementation(async () => ({
      kind: 'upstream-error',
      errorType: 'unknown',
      message: 'offline',
      fetchedAt: Date.now()
    }))
    coordinator.reportVisiblePRRefreshCandidates([makeCandidate()], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)

    policy.setPRAutoRefreshCadence('default')
    coordinator.retimePRRefreshesForCadence()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60_000 + 1_000)
    expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
  })

  describe('foreground exposure under a stretched cadence', () => {
    const openPR = {
      cachedHasPR: true,
      cachedPRState: 'open',
      cachedChecksStatus: 'pending'
    } as const

    it('reads the selected PR at once when it comes to the foreground, then follows the stretched interval', async () => {
      const { coordinator } = await loadCoordinatorWithCadence('reduced')
      const fetchedAt = Date.now() - 30_000
      const selected = makeCandidate({ ...openPR, isSelected: true, cachedFetchedAt: fetchedAt })
      coordinator.reportVisiblePRRefreshCandidates([selected], 1, 1)
      await vi.advanceTimersByTimeAsync(90_000)
      expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(0)

      // What the renderer sends for the selected workspace when it comes to the foreground: the
      // data is two minutes old, past Default's minute but well inside Reduced's five.
      coordinator.enqueuePRRefresh(selected, 'visible', 80, 1)
      await vi.advanceTimersByTimeAsync(0)
      expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(5 * 60_000 - 2_000)
      expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(3_000)
      expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
    })

    it('reads a re-shown row whose data is older than the Default interval', async () => {
      const { coordinator } = await loadCoordinatorWithCadence('reduced')
      coordinator.reportVisiblePRRefreshCandidates(
        [makeCandidate({ ...openPR, cachedFetchedAt: Date.now() - 3 * 60_000 })],
        1,
        1
      )
      await vi.advanceTimersByTimeAsync(0)
      expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)

      // The timed read after it follows the stretched (10 min) interval.
      await vi.advanceTimersByTimeAsync(9 * 60_000)
      expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(60_000 + 1_000)
      expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(2)
    })

    it('leaves a re-shown row alone while its data is newer than the Default interval', async () => {
      const { coordinator } = await loadCoordinatorWithCadence('reduced')
      coordinator.reportVisiblePRRefreshCandidates(
        [makeCandidate({ ...openPR, cachedFetchedAt: Date.now() - 60_000 })],
        1,
        1
      )
      await vi.advanceTimersByTimeAsync(8 * 60_000)
      expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(0)
      await vi.advanceTimersByTimeAsync(60_000 + 1_000)
      expect(getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
    })
  })
})
