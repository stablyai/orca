import { expect, it, vi } from 'vitest'
import { makeCandidate, makePR } from './pr-refresh-coordinator-test-harness'
import { getPRForBranchOutcome } from '../../client/lookup/pr-for-branch-outcome'
import { runHostedPRRead } from './pr-refresh-coordinator'
import { refreshIntervalForCandidate } from './pr-refresh-candidate-policy'

vi.mock('../../client/lookup/branch-lookup-resolution', () => ({
  resolvePRForBranchOutcome: async () => ({
    kind: 'found',
    fetchedAt: Date.now(),
    pr: makePR({
      headSha: 'head',
      checksStatus: 'success',
      checksReadComplete: true,
      checksFinal: true,
      autoMergeEnabled: false,
      mergeQueueRequired: false
    })
  })
}))
vi.mock('../../execution/github-operation-slots', () => ({
  acquire: async () => {},
  release: () => {}
}))

it('stretches a confirmed quiet PR’s interval by the cadence, as it does every other interval', async () => {
  const candidate = makeCandidate({
    branch: 'branch',
    currentHeadOid: 'head',
    cachedHeadOid: 'head',
    cachedFetchedAt: 2_000,
    cachedPRState: 'open',
    cachedChecksStatus: 'success',
    cachedHasPR: true
  })
  const read = () =>
    runHostedPRRead(candidate, () =>
      getPRForBranchOutcome('/repo', 'branch', null, null, null, { currentHeadOid: 'head' })
    )
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  await read()
  vi.setSystemTime(2_000)
  await read()
  const unconfirmed = { ...candidate, fallbackPRNumber: 9 }
  expect(
    (['default', 'reduced', 'minimal', 'off'] as const).map((cadence) => [
      refreshIntervalForCandidate(candidate, cadence),
      refreshIntervalForCandidate(unconfirmed, cadence)
    ])
  ).toEqual([
    [300_000, 120_000],
    [1_500_000, 600_000],
    [3_000_000, 1_200_000],
    [Infinity, Infinity]
  ])
  vi.useRealTimers()
})
