import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { harness, snapshots } from './workspace-review-subscription.test-fixture'
import { makeCandidate, makePR } from '../github/pr-refresh-coordinator-test-harness'
import { aliasFromCandidate, sameAliasRequestIdentity } from '../github/pr-refresh-candidate-policy'

const { mocks, modules } = await vi.hoisted(async () => {
  const modules = await import('../github/pr-refresh-coordinator-test-mocks')
  return { mocks: modules.createPRRefreshCoordinatorMocks(), modules }
})
vi.mock('./runtime-desktop-surface', () => modules.runtimeDesktopSurfaceModuleMock(mocks))
vi.mock('../github/client', () => modules.clientModuleMock(mocks))
vi.mock('../github/github-api-repository', () => modules.githubApiRepositoryModuleMock(mocks))
vi.mock('../github/rate-limit', () => modules.rateLimitModuleMock(mocks))

beforeEach(() => {
  vi.useFakeTimers()
  modules.resetPRRefreshCoordinatorMocks(mocks)
})
afterEach(() => {
  vi.useRealTimers()
})

it('publishes desktop null-host completions to mobile local-host interest through unchanged renewals', async () => {
  const h = await harness()
  mocks.getAllWebContentsMock.mockReturnValue([{ id: 1, isDestroyed: () => false }])
  mocks.getPRForBranchOutcomeMock.mockImplementation(async () => ({
    kind: 'found',
    pr: makePR(),
    fetchedAt: Date.now()
  }))
  const desktop = { ...h.candidate, executionHostId: null }
  h.coordinator.reportVisiblePRRefreshCandidates([desktop], 1, 1)
  const mobile = h.open()
  await mobile.renew()
  h.coordinator.reportVisiblePRRefreshCandidates([desktop], 2, 1)
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
  expect(snapshots(h.frames).at(-1)?.review?.number).toBe(12)
  await vi.advanceTimersByTimeAsync(45_000)
  await mobile.renew()
  h.coordinator.reportVisiblePRRefreshCandidates([desktop], 3, 1)
  await vi.advanceTimersByTimeAsync(5_000)
  await mobile.renew()
  expect(mocks.getPRForBranchOutcomeMock).toHaveBeenCalledTimes(1)
  expect(snapshots(h.frames).at(-1)).toMatchObject({
    review: { number: 12 },
    fetchedAt: 1000,
    stale: false
  })
  mobile.close()
  h.coordinator.clearVisiblePRRefreshWindow(1)
})

it('recognizes a legacy SSH connection and its explicit host as the same request owner', () => {
  const legacy = aliasFromCandidate(
    makeCandidate({ connectionId: 'server-a', executionHostId: null })
  )
  expect(sameAliasRequestIdentity(legacy, { ...legacy, executionHostId: 'ssh:server-a' })).toBe(
    true
  )
})

it.each([
  ['local', 'runtime:server-a'],
  ['runtime:server-a', 'runtime:server-b'],
  ['ssh:server-a', 'ssh:server-b'],
  [null, 'local']
])('keeps distinct execution owners isolated: %s versus %s', (leftHost, rightHost) => {
  const alias = aliasFromCandidate(makeCandidate({ connectionId: 'server-a' }))
  expect(
    sameAliasRequestIdentity(
      { ...alias, executionHostId: leftHost },
      { ...alias, executionHostId: rightHost }
    )
  ).toBe(false)
})
