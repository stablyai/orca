import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { PRCheckDetail } from '../../../../shared/github/check-types'
import { setPRAutoRefreshCadence } from '../../../../shared/review-refresh-policy'
import { _resetPacedPRChecksForTests } from '../../../github/client/check/pr-checks-last-outcome'
import {
  __resetHostedReviewScopeGenerationsForTests,
  bumpScopeGeneration,
  hostedReviewRepoScope
} from '../../../source-control/hosted-review-scope-generations'

const mocks = vi.hoisted(() => ({ getPRChecks: vi.fn() }))
vi.mock('../../../github/client/check/get-pr-checks', () => ({ getPRChecks: mocks.getPRChecks }))
vi.mock('../../../github/issues', () => ({ getIssue: vi.fn() }))
vi.mock('../../../github/client/check/get-pr-check-details', () => ({ getPRCheckDetails: vi.fn() }))
vi.mock('../../../github/client/fetch/get-pr-comments', () => ({ getPRComments: vi.fn() }))
vi.mock('../../../github/work-item-details', () => ({ getPRFileContents: vi.fn() }))

import { RuntimeGitHubReviewQueryCommands } from './runtime-github-review-query-commands'

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0,
  kind: 'git'
}
const commands = new RuntimeGitHubReviewQueryCommands({
  resolveRepo: async () => repo,
  getLocalGitArgs: () => []
})
const prRepo = { owner: 'acme', repo: 'repo' }
let reads = 0
function check(name: string): PRCheckDetail {
  return { name, status: 'completed', conclusion: 'success', url: null }
}

describe('github.prChecks follows the host’s PR auto-refresh cadence', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
    reads = 0
    _resetPacedPRChecksForTests()
    __resetHostedReviewScopeGenerationsForTests()
    mocks.getPRChecks.mockReset().mockImplementation(async () => [check(`read-${++reads}`)])
  })
  afterEach(() => {
    setPRAutoRefreshCadence('default')
    vi.useRealTimers()
  })

  const timed = (overrides: Record<string, unknown> = {}) =>
    commands.getRepoPRChecks(repo.id, 7, 'head-a', prRepo, { reason: 'swr', ...overrides })

  it('reads the provider for every timed read by default', async () => {
    await timed()
    vi.advanceTimersByTime(60_000)
    await timed()
    expect(mocks.getPRChecks).toHaveBeenCalledTimes(2)
  })

  it('answers a client’s timed read from the last read while off, and after a minute', async () => {
    setPRAutoRefreshCadence('off')
    const first = await timed()
    vi.advanceTimersByTime(60_000)
    const second = await timed()
    expect(second).toBe(first)
    expect(mocks.getPRChecks).toHaveBeenCalledTimes(1)
  })

  it('reads again once the host’s own stretched interval has passed', async () => {
    setPRAutoRefreshCadence('reduced')
    await timed()
    vi.advanceTimersByTime(4 * 60_000)
    await timed()
    expect(mocks.getPRChecks).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_000)
    await timed()
    expect(mocks.getPRChecks).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['an opened panel or returned window', { foreground: true }],
    ['a manual refresh', { userRefresh: true }],
    ['a changed-state read', { noCache: true }],
    ['a read without a reason', { reason: undefined }]
  ])('still reads the provider for %s while off', async (_label, overrides) => {
    setPRAutoRefreshCadence('off')
    await timed()
    await timed(overrides)
    expect(mocks.getPRChecks).toHaveBeenCalledTimes(2)
  })

  it('never answers one head’s checks for another', async () => {
    setPRAutoRefreshCadence('off')
    await timed()
    await commands.getRepoPRChecks(repo.id, 7, 'head-b', prRepo, { reason: 'swr' })
    expect(mocks.getPRChecks).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['a manual refresh', { userRefresh: true }],
    ['an opened panel or returned window', { foreground: true }],
    ['a changed-state read', { noCache: true }],
    ['a read without a reason', { reason: undefined }]
  ])(
    'hands the next timed client the fresher result of %s, not the older timed read',
    async (_label, overrides) => {
      setPRAutoRefreshCadence('reduced')
      const stale = await timed()
      vi.advanceTimersByTime(60_000)
      const fresh = await timed(overrides)
      expect(fresh).not.toEqual(stale)
      vi.advanceTimersByTime(60_000)
      expect(await timed()).toEqual(fresh)
      expect(mocks.getPRChecks).toHaveBeenCalledTimes(2)
    }
  )

  it('while off, a manual refresh replaces the answer every later timed read gets', async () => {
    setPRAutoRefreshCadence('off')
    await timed()
    vi.advanceTimersByTime(60_000)
    const fresh = await timed({ userRefresh: true })
    vi.advanceTimersByTime(60 * 60_000)
    expect(await timed()).toEqual(fresh)
    expect(mocks.getPRChecks).toHaveBeenCalledTimes(2)
  })

  it('an older timed read that settles after a newer foreground read does not replace it', async () => {
    setPRAutoRefreshCadence('off')
    let finishSlow!: (checks: PRCheckDetail[]) => void
    mocks.getPRChecks
      .mockImplementationOnce(
        () => new Promise<PRCheckDetail[]>((resolve) => (finishSlow = resolve))
      )
      .mockImplementation(async () => [check(`read-${++reads}`)])
    const slow = timed()
    const fresh = await timed({ foreground: true })
    finishSlow([check('older')])
    await slow
    expect(await timed()).toEqual(fresh)
    expect(mocks.getPRChecks).toHaveBeenCalledTimes(2)
  })

  it('a failed read leaves the last successful answer in place', async () => {
    setPRAutoRefreshCadence('off')
    const first = await timed()
    mocks.getPRChecks.mockRejectedValueOnce(new Error('offline'))
    await expect(timed({ userRefresh: true })).rejects.toThrow('offline')
    expect(await timed()).toEqual(first)
  })

  it('does not answer one gh account’s checks to another', async () => {
    setPRAutoRefreshCadence('off')
    let user = 'alice'
    const scoped = new RuntimeGitHubReviewQueryCommands({
      resolveRepo: async () => repo,
      getLocalGitArgs: () => [{ ghAccount: { host: 'github.com', user } }]
    })
    const read = () => scoped.getRepoPRChecks(repo.id, 7, 'head-a', prRepo, { reason: 'swr' })
    const alice = await read()
    expect(await read()).toEqual(alice)
    user = 'bob'
    expect(await read()).not.toEqual(alice)
    expect(mocks.getPRChecks).toHaveBeenCalledTimes(2)
  })

  it('reads again after the repository’s review scope generation is bumped', async () => {
    setPRAutoRefreshCadence('off')
    await timed()
    bumpScopeGeneration(hostedReviewRepoScope(repo.path, 'local'))
    await timed()
    expect(mocks.getPRChecks).toHaveBeenCalledTimes(2)
  })
})
