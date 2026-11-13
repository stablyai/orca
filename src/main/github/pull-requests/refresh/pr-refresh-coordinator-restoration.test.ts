import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PRRefreshOutcome } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import { makeCandidate, makePR } from './pr-refresh-coordinator-test-harness'

const { coordinatorMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./pr-refresh-coordinator-test-mocks')
  return { coordinatorMocks: moduleMocks.createPRRefreshCoordinatorMocks(), moduleMocks }
})
// Only the provider and the rate-limit probe are faked: the lookup, its exact cache, the retry
// owner and the queue are the real ones.
const provider = vi.hoisted(() => ({ resolve: vi.fn(), gate: vi.fn() }))
vi.mock('./pr-refresh-renderer-port', () => moduleMocks.rendererPortModuleMock(coordinatorMocks))
vi.mock('./pr-refresh-rate-limit-gate', () => ({
  prRefreshRateLimitPausedUntil: provider.gate
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
  vi.setSystemTime(1_000)
  provider.gate.mockReset().mockResolvedValue(null)
  provider.resolve.mockReset().mockImplementation(async () => found('first'))
})
afterEach(() => vi.useRealTimers())

function found(title: string): PRRefreshOutcome {
  return {
    kind: 'found',
    fetchedAt: Date.now(),
    pr: makePR({ title, checksStatus: 'pending' })
  }
}

function failed(): PRRefreshOutcome {
  return { kind: 'upstream-error', errorType: 'network', message: 'offline', fetchedAt: Date.now() }
}

const readsOf = (branch: string) =>
  provider.resolve.mock.calls.filter(([read]) => read.branchName === branch).length

async function load() {
  const policy = await import('../../../../shared/review-refresh-policy')
  const coordinator = await import('./pr-refresh-coordinator')
  const lookup = await import('../../client/lookup/pr-for-branch-outcome')
  const resources = await import('../../client/lookup/pr-branch-read-resources')
  const switchTo = async (cadence: 'default' | 'off', at: number) => {
    await vi.advanceTimersByTimeAsync(at - Date.now())
    policy.setPRAutoRefreshCadence(cadence)
    coordinator.retimePRRefreshesForCadence()
  }
  return { coordinator, lookup, resources, switchTo }
}

it('restores a failure the full exact cache could not keep as its own retry, which Off retires again', async () => {
  const { coordinator, lookup, resources, switchTo } = await load()
  // 256 other exact results, each held: the exact cache has no room for another.
  const holds: (() => void)[] = []
  for (let other = 0; other < 256; other += 1) {
    const prepared = await lookup.preparePRBranchRead('/repo', `other-${other}`, null, null, null, {
      currentHeadOid: 'head-sha'
    })
    await prepared.read()
    holds.push(prepared.hold())
  }
  provider.resolve.mockImplementation(async () => failed())
  const target = makeCandidate({ branch: 'target', currentHeadOid: 'head-sha' })
  // Fails at 1 s with no exact entry; Default would retry it at 121 s.
  coordinator.reportVisiblePRRefreshCandidates([target], 1, 1)
  await vi.advanceTimersByTimeAsync(0)
  expect(readsOf('target')).toBe(1)
  for (const release of holds) {
    release()
  }

  await switchTo('off', 1_500)
  await switchTo('default', 2_000)
  await switchTo('off', 3_000)
  await vi.advanceTimersByTimeAsync(130_000 - Date.now())
  expect(readsOf('target')).toBe(1)

  provider.resolve.mockImplementation(async () => found('recovered'))
  await switchTo('default', Date.now())
  await vi.advanceTimersByTimeAsync(0)
  expect(readsOf('target')).toBe(2)
  expect(coordinatorMocks.sendToTrustedUIRendererMock.mock.calls.at(-1)?.[1]).toMatchObject({
    outcome: { pr: { title: 'recovered' } }
  })
  // Recovery released the failure's claim on its request.
  expect(resources._prBranchReadResourceCountForTests()).toBe(0)
})

it('owes no retry for a failure a newer read of the same request had already replaced', async () => {
  const { coordinator, lookup } = await load()
  const { hostedReviewOptionArgs } = await import('./pr-refresh-candidate-policy')
  // The exact cache is full, so neither read below keeps its outcome there.
  for (let other = 0; other < 256; other += 1) {
    const prepared = await lookup.preparePRBranchRead('/repo', `other-${other}`, null, null, null, {
      currentHeadOid: 'head-sha'
    })
    await prepared.read()
    prepared.hold()
  }
  const target = makeCandidate({ branch: 'target', currentHeadOid: 'head-sha' })
  const late = Promise.withResolvers<PRRefreshOutcome>()
  provider.resolve.mockImplementationOnce(() => late.promise)
  coordinator.reportVisiblePRRefreshCandidates([target], 1, 1)
  await vi.advanceTimersByTimeAsync(0)
  // A fresh read of the same request through the direct caller path, as a paired client's
  // foreground read does, starts after it and succeeds first.
  const options = hostedReviewOptionArgs(target, 'active')[0] ?? {}
  await coordinator.runHostedPRRead(target, () =>
    lookup.getPRForBranchOutcome('/repo', 'target', null, null, null, options)
  )
  late.resolve(failed())
  await vi.advanceTimersByTimeAsync(10 * 60_000)
  expect(readsOf('target')).toBe(2)
})

it.each(['automatic', 'shown again'] as const)(
  'Off retires a restored follow-up waiting its turn, but not one a return upgraded (%s)',
  async (kind) => {
    const { coordinator, lookup, switchTo } = await load()
    const x = makeCandidate({ branch: 'x', currentHeadOid: 'head-sha' })
    coordinator.reportVisiblePRRefreshCandidates([x], 1, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(readsOf('x')).toBe(1)
    const shownX = {
      ...x,
      cachedFetchedAt: 1_000,
      cachedHeadOid: 'head-sha',
      cachedHasPR: true,
      cachedPRState: 'open' as const,
      cachedChecksStatus: 'pending' as const
    }
    await switchTo('off', 2_000)
    // Other reads push X's exact answer out of the bounded cache while X stays visible.
    for (let other = 0; other < 256; other += 1) {
      await lookup.getPRForBranchOutcome('/repo', `other-${other}`, null, null, null, {
        currentHeadOid: 'head-sha'
      })
    }
    // A newly shown Y reads under Off, and its budgeted start spaces the next one by 10 s.
    await vi.advanceTimersByTimeAsync(199_000 - Date.now())
    const y = makeCandidate({ branch: 'y', worktreeId: 'wt-y', cacheKey: '/repo::y' })
    coordinator.reportVisiblePRRefreshCandidates([shownX, y], 2, 1)
    await vi.advanceTimersByTimeAsync(0)
    expect(readsOf('y')).toBe(1)

    await switchTo('default', 200_000)
    if (kind === 'shown again') {
      coordinator.clearVisiblePRRefreshWindow(1)
      coordinator.reportVisiblePRRefreshCandidates([shownX, y], 3, 1)
    }
    await switchTo('off', 201_000)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(readsOf('x')).toBe(kind === 'shown again' ? 2 : 1)

    provider.resolve.mockImplementation(async () => found('changed'))
    await switchTo('default', Date.now())
    await vi.advanceTimersByTimeAsync(15_000)
    // The automatic one is restored and reads now; the shown-again one already read under Off.
    expect(readsOf('x')).toBe(2)
  }
)

it('a restored follow-up that waited for quota does not start once Off arrives', async () => {
  const { coordinator, switchTo } = await load()
  const x = makeCandidate({ branch: 'x', currentHeadOid: 'head-sha' })
  coordinator.reportVisiblePRRefreshCandidates([x], 1, 1)
  await vi.advanceTimersByTimeAsync(0)
  await switchTo('off', 2_000)
  await vi.advanceTimersByTimeAsync(200_000 - Date.now())
  const quota = Promise.withResolvers<number | null>()
  provider.gate.mockReturnValueOnce(quota.promise)
  await switchTo('default', 200_000)
  await vi.advanceTimersByTimeAsync(0)
  expect(provider.gate).toHaveBeenCalled()
  await switchTo('off', 201_000)
  quota.resolve(null)
  await vi.advanceTimersByTimeAsync(60 * 60_000)
  expect(readsOf('x')).toBe(1)
})
