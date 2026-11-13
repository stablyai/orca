import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { makeCandidate, makePR } from './pr-refresh-coordinator-test-harness'

const { coordinatorMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./pr-refresh-coordinator-test-mocks')
  return { coordinatorMocks: moduleMocks.createPRRefreshCoordinatorMocks(), moduleMocks }
})
// Only the provider is faked: the read, its exact cached result and the queue are the real ones.
const provider = vi.hoisted(() => ({ resolve: vi.fn() }))
vi.mock('./pr-refresh-renderer-port', () => moduleMocks.rendererPortModuleMock(coordinatorMocks))
vi.mock('./pr-refresh-rate-limit-gate', () => ({
  prRefreshRateLimitPausedUntil: async () => null
}))
vi.mock('../../client/lookup/branch-lookup-resolution', () => ({
  resolvePRForBranchOutcome: provider.resolve
}))
vi.mock('../../execution/github-operation-slots', () => ({
  acquire: async () => {},
  release: () => {}
}))

beforeEach(() => {
  moduleMocks.resetPRRefreshCoordinatorMocks(coordinatorMocks)
  provider.resolve.mockReset().mockImplementation(async () => ({
    kind: 'found',
    fetchedAt: Date.now(),
    pr: makePR({ checksStatus: 'pending' })
  }))
})
afterEach(() => vi.useRealTimers())

it.each(['default', 'reduced', 'off'] as const)(
  'a return to a PR whose data is past the Default interval reads it under %s, then follows the timers',
  async (cadence) => {
    const policy = await import('../../../../shared/review-refresh-policy')
    policy.setPRAutoRefreshCadence(cadence)
    const coordinator = await import('./pr-refresh-coordinator')
    const candidate = makeCandidate({ isSelected: true, currentHeadOid: 'head-sha' })
    coordinator.reportVisiblePRRefreshCandidates([candidate], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.resolve).toHaveBeenCalledTimes(1)

    coordinator.clearVisiblePRRefreshWindow(1)
    await vi.advanceTimersByTimeAsync(90_000)
    coordinator.reportVisiblePRRefreshCandidates(
      [
        {
          ...candidate,
          cachedFetchedAt: 1_000,
          cachedHeadOid: 'head-sha',
          cachedHasPR: true,
          cachedPRState: 'open',
          cachedChecksStatus: 'pending'
        }
      ],
      2,
      1
    )
    await vi.advanceTimersByTimeAsync(0)
    expect(provider.resolve).toHaveBeenCalledTimes(2)

    // Default keeps its one-minute timer; Reduced waits five minutes and Off has none.
    await vi.advanceTimersByTimeAsync(4 * 60_000)
    expect(provider.resolve.mock.calls.length > 2).toBe(cadence === 'default')
  }
)
