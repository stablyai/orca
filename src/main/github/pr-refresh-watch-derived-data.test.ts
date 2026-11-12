import { afterEach, expect, it, vi } from 'vitest'
import type { PRRefreshOutcome } from '../../shared/github/pull-request-refresh-types'
import type { PullRequestLookupData } from './client/lookup/pull-request-lookup-data'
import { makeCandidate } from './pr-refresh-coordinator-test-harness'

const fixture = vi.hoisted(() => ({
  lookup: vi.fn(),
  conflict: vi.fn(),
  stack: { number: 2, position: 1, size: 2, baseRefName: 'main', baseSha: 'base-sha' }
}))
vi.mock('./github-api-repository', () => ({
  resolveGitHubApiRepositoryCandidates: async () => ({
    candidates: [{ owner: 'acme', repo: 'widgets' }],
    headRepo: { owner: 'acme', repo: 'widgets' }
  }),
  getOriginGitHubApiRepository: async () => ({ owner: 'acme', repo: 'widgets' })
}))
vi.mock('./rate-limit', () => ({
  repositoryRateLimitGuard: () => ({ blocked: false }),
  spendsSharedGitHubComQuota: () => false
}))
vi.mock('./client/lookup/pr-number-lookup', () => ({ lookupPRByNumber: fixture.lookup }))
vi.mock('./client/lookup/pr-stack-summary-cache', () => ({
  getCachedGitHubPRStackSummary: async () => fixture.stack
}))
vi.mock('./github-pr-stack', () => ({ hydrateGitHubPRStack: async () => fixture.stack }))
vi.mock('./client/detect/repository-merge-metadata', () => ({
  detectRepositoryMergeMetadata: async () => ({ mergeQueueRequired: true })
}))
vi.mock('./conflict-summary', () => ({ getPRConflictSummary: fixture.conflict }))

const data: PullRequestLookupData = {
  number: 12,
  title: 'Conflicting change',
  state: 'OPEN',
  url: 'https://github.com/acme/widgets/pull/12',
  updatedAt: '2026-11-11T00:00:00Z',
  mergeable: 'CONFLICTING',
  baseRefName: 'main',
  baseRefOid: 'base-sha',
  headRefName: 'topic',
  headRefOid: 'head-sha',
  checksUnavailable: false,
  statusCheckRollup: [{ __typename: 'CheckRun', name: 'build', status: 'IN_PROGRESS' }]
}
const summary = { baseRef: 'main', baseCommit: 'base-sh', commitsBehind: 1, files: ['a.ts'] }

afterEach(() => vi.useRealTimers())

it('watches preserve provider checks while full and phone reads retain derived details', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000)
  fixture.lookup.mockImplementation(async () => ({
    data: { ...data },
    dataRepo: { owner: 'acme', repo: 'widgets' }
  }))
  fixture.conflict.mockResolvedValue(summary)
  const { addPRRefreshOutcomeObserver, schedulePRWatchRead } =
    await import('./pr-refresh-coordinator')
  const { getPRForBranchOutcome, readRecentPhonePROutcome } =
    await import('./client/lookup/pr-for-branch-outcome')
  const candidate = makeCandidate({ branch: 'topic', linkedPRNumber: 12 })
  const watched = Promise.withResolvers<PRRefreshOutcome>()
  const unsubscribe = addPRRefreshOutcomeObserver((_, outcome) => watched.resolve(outcome))
  schedulePRWatchRead({ prKey: 'github.com/acme/widgets#12' }, candidate, Date.now())
  await vi.advanceTimersByTimeAsync(0)
  const watch = await watched.promise
  unsubscribe()
  expect(watch).toMatchObject({
    kind: 'found',
    pr: { number: 12, headSha: 'head-sha', state: 'open', checksStatus: 'pending' }
  })
  if (watch.kind !== 'found') {
    throw new Error('watch did not find the PR')
  }
  expect(watch.pr.conflictSummary).toBeUndefined()
  expect(watch.pr.stack).toBeUndefined()
  expect(watch.pr.mergeQueueRequired).toBeUndefined()

  // An uncapped partial read must also stay separate from a concurrent full read.
  const provider = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const conflict = Promise.withResolvers<typeof summary>()
  fixture.lookup.mockImplementation(async () => {
    entered.resolve()
    await provider.promise
    return { data: { ...data }, dataRepo: { owner: 'acme', repo: 'widgets' } }
  })
  fixture.conflict.mockReturnValue(conflict.promise)
  const partial = getPRForBranchOutcome('/repo', 'topic', 12, null, null, {
    includeDerivedData: false
  })
  await entered.promise
  const full = getPRForBranchOutcome('/repo', 'topic', 12, null, null)
  provider.resolve()
  try {
    expect(await partial).toMatchObject({ kind: 'found', pr: { conflictSummary: undefined } })
    expect(
      await readRecentPhonePROutcome('/repo', 'topic', 12, null, null, {
        currentHeadOid: 'head-sha'
      })
    ).toBeNull()
  } finally {
    conflict.resolve(summary)
  }
  const complete = await full
  expect(complete).toMatchObject({
    kind: 'found',
    pr: {
      number: 12,
      headSha: 'head-sha',
      checksStatus: 'pending',
      conflictSummary: { files: ['a.ts'], commitsBehind: 1 },
      stack: { number: 2, baseRefName: 'main' },
      mergeQueueRequired: true
    }
  })
  expect(
    await readRecentPhonePROutcome('/repo', 'topic', 12, null, null, { currentHeadOid: 'head-sha' })
  ).toEqual(complete)
})
