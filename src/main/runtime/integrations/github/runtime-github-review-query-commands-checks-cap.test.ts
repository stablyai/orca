import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { PRCheckDetail } from '../../../../shared/github/check-types'
import { setPRAutoRefreshCadence } from '../../../../shared/review-refresh-policy'
import { _resetPacedPRChecksForTests } from '../../../github/client/check/pr-checks-last-outcome'

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
})
