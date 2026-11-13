import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PRRefreshOutcome } from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import { makeCandidate, makePR } from './pr-refresh-coordinator-test-harness'

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), send: vi.fn(), selection: 0 }))
vi.mock('../../client/lookup/branch-lookup-resolution', () => ({
  resolvePRForBranchOutcome: mocks.resolve
}))
vi.mock('../../accounts/github-project-account', () => ({
  githubPRPolicyProjects: () => ({ source: null, selection: mocks.selection }),
  resolveGitHubProjectAccount: () => null
}))
vi.mock('../../execution/github-operation-slots', () => ({
  acquire: async () => {},
  release: () => {}
}))
vi.mock('./pr-refresh-rate-limit-gate', () => ({ prRefreshRateLimitPausedUntil: async () => null }))
vi.mock('./pr-refresh-renderer-port', () => ({
  prRefreshRenderers: () => ({ isRendererOpen: () => true, sendToTrustedUI: mocks.send })
}))

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  mocks.selection = 0
  mocks.resolve.mockReset()
  mocks.send.mockReset()
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

function found(overrides: Parameters<typeof makePR>[0] = {}): PRRefreshOutcome {
  return {
    kind: 'found',
    fetchedAt: Date.now(),
    pr: makePR({
      checksStatus: 'success',
      checksReadComplete: true,
      checksFinal: true,
      autoMergeEnabled: false,
      mergeQueueRequired: false,
      ...overrides
    })
  }
}

it('delivers a real refresh after quiet evidence retires without repeating the cached follow-up', async () => {
  mocks.resolve.mockImplementation(async () => found())
  const coordinator = await import('./pr-refresh-coordinator')
  const { getPRForBranchOutcome } = await import('../../client/lookup/pr-for-branch-outcome')
  const candidate = makeCandidate({ currentHeadOid: 'head-sha' })
  const seed = () =>
    coordinator.runHostedPRRead(candidate, () =>
      getPRForBranchOutcome('/repo', candidate.branch, null, null, null, {
        currentHeadOid: 'head-sha'
      })
    )
  await seed()
  vi.setSystemTime(2_000)
  await seed()
  const visible = {
    ...candidate,
    cachedFetchedAt: 2_000,
    cachedHeadOid: 'head-sha',
    cachedHasPR: true,
    cachedPRState: 'open' as const,
    cachedChecksStatus: 'success' as const
  }
  coordinator.reportVisiblePRRefreshCandidates([visible], 1, 1)
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.resolve).toHaveBeenCalledTimes(2)
  vi.setSystemTime(132_001)
  mocks.selection++
  mocks.resolve.mockImplementation(async () => found({ title: 'updated' }))
  mocks.send.mockClear()
  mocks.send.mockImplementation(() => {
    // Bound the unfixed synchronous loop even though its fake clock would otherwise never advance.
    if (mocks.send.mock.calls.length === 8) {
      vi.setSystemTime(1_000_000)
    }
  })
  coordinator.reportVisiblePRRefreshCandidates([visible], 2, 1)
  await vi.advanceTimersByTimeAsync(0)
  expect(mocks.resolve).toHaveBeenCalledTimes(3)
  expect(mocks.send.mock.calls.length).toBeLessThanOrEqual(2)
  expect(mocks.send.mock.calls.at(-1)?.[1]).toMatchObject({
    outcome: { fetchedAt: 132_001, pr: { title: 'updated' } }
  })
  await vi.advanceTimersByTimeAsync(120_001)
  expect(mocks.send.mock.calls.at(-1)?.[1]).toMatchObject({
    outcome: { fetchedAt: 252_001, pr: { title: 'updated' } }
  })
})

it('rereads unresolved manual mergeability at its forced follow-up despite the timed cache', async () => {
  mocks.resolve
    .mockImplementationOnce(async () =>
      found({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })
    )
    .mockImplementation(async () => found({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' }))
  const coordinator = await import('./pr-refresh-coordinator')
  const candidate = makeCandidate({ currentHeadOid: 'head-sha' })
  coordinator.reportVisiblePRRefreshCandidates([candidate], 1, 1)
  expect(await coordinator.refreshPRNow(candidate)).toMatchObject({
    pr: { mergeable: 'UNKNOWN' }
  })
  await vi.advanceTimersByTimeAsync(2_501)
  expect(mocks.resolve).toHaveBeenCalledTimes(2)
  expect(mocks.send.mock.calls.at(-1)?.[1]).toMatchObject({
    outcome: { pr: { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' } }
  })
})
