import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PRRefreshOutcome } from '../../shared/github/pull-request-refresh-types'
import type { GitHubRepoContext, LocalGitExecOptions } from './github-repository-identity'
import { getRepoExecutionHostId } from '../../shared/execution-host'
import { hostedReviewInfoFromGitHubPRInfo } from '../../shared/hosted-review-github'
import { makePR } from './pr-refresh-coordinator-test-harness'
import {
  __resetHostedReviewBranchCacheForTests,
  invalidateHostedReviewBranchCache,
  withHostedReviewBranchCache
} from '../source-control/hosted-review-branch-cache'

const mocks = vi.hoisted(() => ({ resolve: vi.fn(), acquire: vi.fn(), release: vi.fn() }))
vi.mock('./gh-utils', () => ({
  acquire: mocks.acquire,
  release: mocks.release,
  githubRepoContext: (
    repoPath: string,
    connectionId: string | null,
    options: LocalGitExecOptions
  ) => ({
    repoPath,
    connectionId,
    ...options
  }),
  ghRepoExecOptions: (context: GitHubRepoContext) => context
}))
vi.mock('./client/lookup/branch-lookup-resolution', () => ({
  resolvePRForBranchOutcome: mocks.resolve
}))
vi.mock('./client', async () => ({
  getPRForBranchOutcome: (await import('./client/lookup/pr-for-branch-outcome'))
    .getPRForBranchOutcome,
  getRepoSlug: vi.fn(async () => ({ owner: 'acme', repo: 'orca' })),
  getGitHubPRLookupRateLimitBlock: vi.fn(async () => null),
  createGitHubPullRequest: vi.fn()
}))
vi.mock('../gitlab/client', () => ({ getProjectSlug: vi.fn(async () => null) }))
import { getPRForBranchOutcome } from './client/lookup/pr-for-branch-outcome'

const outcome: PRRefreshOutcome = { kind: 'no-pr', fetchedAt: 1 }
beforeEach(() => {
  vi.clearAllMocks()
  mocks.resolve.mockReset()
  __resetHostedReviewBranchCacheForTests()
  mocks.acquire.mockResolvedValue(undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('PR lookup coalescing', () => {
  it('shares pending reads across callers and releases them after settlement', async () => {
    let finish: ((value: PRRefreshOutcome) => void) | undefined
    mocks.resolve.mockImplementation(
      () =>
        new Promise<PRRefreshOutcome>((resolve) => {
          finish = resolve
        })
    )
    const first = getPRForBranchOutcome('/repo', 'refs/heads/topic')
    const second = getPRForBranchOutcome('/repo', 'topic')
    await vi.waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(1))
    finish?.(outcome)
    expect(await Promise.all([first, second])).toEqual([outcome, outcome])
    mocks.resolve.mockResolvedValue(outcome)
    await getPRForBranchOutcome('/repo', 'topic')
    expect(mocks.resolve).toHaveBeenCalledTimes(2)
  })

  it('shares a background read with a foreground caller of the same lookup', async () => {
    mocks.resolve.mockResolvedValue(outcome)
    await Promise.all([
      getPRForBranchOutcome('/repo', 'topic', null, null, null, {
        localGitExecOptions: { admissionTier: 'background' }
      }),
      getPRForBranchOutcome('/repo', 'topic', null, null, null, {
        localGitExecOptions: { admissionTier: 'interactive' }
      })
    ])
    expect(mocks.resolve).toHaveBeenCalledTimes(1)
  })

  it('isolates heads, fallback hints, accounts, execution hosts, and credentials', async () => {
    mocks.resolve.mockResolvedValue(outcome)
    const requests = [
      getPRForBranchOutcome('/repo', 'topic'),
      getPRForBranchOutcome('/repo', 'topic', 12),
      getPRForBranchOutcome('/repo', 'topic', null, 'ssh-1'),
      getPRForBranchOutcome('/repo', 'topic', null, null, 12),
      getPRForBranchOutcome('/repo', 'topic', null, null, null, { currentHeadOid: 'other-head' }),
      getPRForBranchOutcome('/repo', 'topic', null, null, null, {
        localGitExecOptions: { wslDistro: 'Ubuntu' }
      }),
      getPRForBranchOutcome('/repo', 'topic', null, null, null, {
        localGitExecOptions: { ghAccount: { host: 'github.com', user: 'other' } }
      })
    ]
    vi.stubEnv('GH_TOKEN', 'test-only-other-token')
    requests.push(getPRForBranchOutcome('/repo', 'topic'))
    await Promise.all(requests)
    expect(mocks.resolve).toHaveBeenCalledTimes(8)
  })

  it('cleans up errors so later reads can recover', async () => {
    mocks.resolve.mockRejectedValueOnce(new Error('network down')).mockResolvedValue(outcome)
    const results = await Promise.all([
      getPRForBranchOutcome('/repo', 'topic'),
      getPRForBranchOutcome('/repo', 'topic')
    ])
    expect(results.every((result) => result.kind === 'upstream-error')).toBe(true)
    expect(mocks.resolve).toHaveBeenCalledTimes(1)
    await expect(getPRForBranchOutcome('/repo', 'topic')).resolves.toEqual(outcome)
    expect(mocks.resolve).toHaveBeenCalledTimes(2)
  })

  it.each([
    { label: 'native', connectionId: null, options: {} },
    { label: 'WSL', connectionId: null, options: { localGitExecOptions: { wslDistro: 'Ubuntu' } } },
    { label: 'SSH', connectionId: 'host / encoded', options: {} }
  ])(
    'does not adopt a pre-creation no-PR read after $label invalidation',
    async ({ connectionId, options }) => {
      const created: PRRefreshOutcome = { kind: 'found', pr: makePR({ number: 13 }), fetchedAt: 2 }
      const createdReview = hostedReviewInfoFromGitHubPRInfo(created.pr)
      let finish: (value: PRRefreshOutcome) => void = () => {}
      mocks.resolve
        .mockImplementationOnce(
          () =>
            new Promise<PRRefreshOutcome>((resolve) => {
              finish = resolve
            })
        )
        .mockResolvedValue(created)
      const executionHostId = getRepoExecutionHostId({ connectionId })
      const identity = { repoPath: '/repo', executionHostId, branch: 'topic', ...options }
      const lookup = async () => {
        const result = await getPRForBranchOutcome(
          '/repo',
          'topic',
          null,
          connectionId,
          null,
          options
        )
        if (result.kind === 'upstream-error') {
          throw new Error(result.message)
        }
        return result.kind === 'found' ? hostedReviewInfoFromGitHubPRInfo(result.pr) : null
      }
      const beforeCreation = withHostedReviewBranchCache(identity, { headOid: null }, lookup)
      await vi.waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(1))
      invalidateHostedReviewBranchCache('/repo', executionHostId)
      const afterCreation = withHostedReviewBranchCache(identity, { headOid: null }, lookup)
      try {
        await vi.waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(2))
        await expect(afterCreation).resolves.toEqual(createdReview)
      } finally {
        finish(outcome)
        await Promise.all([beforeCreation, afterCreation])
      }
      await expect(
        withHostedReviewBranchCache(identity, { headOid: null }, lookup)
      ).resolves.toEqual(createdReview)
      expect(mocks.resolve).toHaveBeenCalledTimes(2)
    }
  )

  it('keeps native, WSL, and SSH pending reads scoped during invalidation', async () => {
    const completions: ((value: PRRefreshOutcome) => void)[] = []
    mocks.resolve.mockImplementation(
      () =>
        new Promise<PRRefreshOutcome>((resolve) => {
          completions.push(resolve)
        })
    )
    const native = () => getPRForBranchOutcome('/repo', 'topic')
    const wsl = () =>
      getPRForBranchOutcome('/repo', 'topic', null, null, null, {
        localGitExecOptions: { wslDistro: 'Ubuntu' }
      })
    const ssh = () => getPRForBranchOutcome('/repo', 'topic', null, 'host / encoded')
    const reads = [native(), wsl(), ssh()]
    try {
      await vi.waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(3))
      invalidateHostedReviewBranchCache('/other', 'local')
      reads.push(native(), wsl(), ssh())
      invalidateHostedReviewBranchCache(
        '/repo',
        getRepoExecutionHostId({ connectionId: 'host / encoded' })
      )
      reads.push(native(), wsl(), ssh())
      await vi.waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(4))
      invalidateHostedReviewBranchCache('/repo', 'local')
      reads.push(native(), wsl(), ssh())
      await vi.waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(6))
    } finally {
      for (const finish of completions) {
        finish(outcome)
      }
      await Promise.all(reads)
    }
  })
})

it.each([true, false])(
  'explicit host intent replaces the probe without losing its successor (old first: %s)',
  async (oldFirst) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000)
    const old = Promise.withResolvers<PRRefreshOutcome>()
    const fresh = Promise.withResolvers<PRRefreshOutcome>()
    const merged: PRRefreshOutcome = {
      kind: 'found',
      pr: makePR({ state: 'merged' }),
      fetchedAt: 2
    }
    mocks.resolve.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const before = getPRForBranchOutcome('/repo', 'click', null, null, null)
    await vi.waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(1))
    const intent = { userRefresh: true }
    const click = getPRForBranchOutcome('/repo', 'click', null, null, null, intent)
    try {
      await vi.waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(2))
      if (oldFirst) {
        old.resolve(outcome)
        await before
      }
      const ordinary = getPRForBranchOutcome('/repo', 'click', null, null, null)
      fresh.resolve(merged)
      expect(await click).toEqual(merged)
      expect(await ordinary).toEqual(merged)
      expect(mocks.resolve).toHaveBeenCalledTimes(2)
    } finally {
      old.resolve(outcome)
      fresh.resolve(merged)
      await Promise.all([before, click])
    }
  }
)

it('an explicit hosted GitHub read reaches a new lower probe through the real forge adapter', async () => {
  const { readHostedReviewForBranch } = await import('../source-control/hosted-review')
  const old = Promise.withResolvers<PRRefreshOutcome>()
  const merged: PRRefreshOutcome = {
    kind: 'found',
    pr: makePR({ state: 'merged', headSha: 'new-head' }),
    fetchedAt: 2
  }
  mocks.resolve.mockReturnValueOnce(old.promise).mockResolvedValueOnce(merged)
  const before = getPRForBranchOutcome('/repo', 'adapter', null, null, null)
  await vi.waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(1))
  const click = readHostedReviewForBranch({
    repoPath: '/repo',
    executionHostId: 'local',
    branch: 'adapter',
    userRefresh: true
  })
  try {
    await vi.waitFor(() => expect(mocks.resolve).toHaveBeenCalledTimes(2))
    expect((await click).review).toMatchObject({ state: 'merged' })
  } finally {
    old.resolve(outcome)
    await Promise.all([before, click])
  }
})
