import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  GitHubPRRefreshReason,
  PRRefreshOutcome
} from '../../../../shared/github/pull-request-refresh-types'
import type {
  GitHubRepoContext,
  LocalGitExecOptions
} from '../../../github/github-repository-identity'
import type { Repo } from '../../../../shared/repo-types'
import type { DeviceScope } from '../../../../shared/runtime-session-contracts'
import { makePR } from '../../../github/pr-refresh-coordinator-test-harness'
import { setPRAutoRefreshCadence } from '../../../../shared/review-refresh-policy'
import { createVisibleHostedReviewRefreshScheduler } from '../../../../renderer/src/store/slices/hosted-review/refresh/visible-hosted-review-refresh-scheduler'

const mocks = vi.hoisted(() => ({ resolve: vi.fn() }))
vi.mock('../../../github/gh-utils', () => ({
  acquire: vi.fn(async () => {}),
  release: vi.fn(),
  githubRepoContext: (
    repoPath: string,
    connectionId: string | null,
    options: LocalGitExecOptions
  ) => ({ repoPath, connectionId, ...options }),
  ghRepoExecOptions: (context: GitHubRepoContext) => context
}))
vi.mock('../../../github/client/lookup/branch-lookup-resolution', () => ({
  resolvePRForBranchOutcome: mocks.resolve
}))
vi.mock('../../../github/pr-refresh-coordinator', () => ({
  runHostedPRRead: (_candidate: unknown, read: () => Promise<PRRefreshOutcome>) => read()
}))
import { RuntimeHostedReviewCommands } from './runtime-hosted-review-commands'

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'repo',
  badgeColor: '#000',
  addedAt: 0,
  kind: 'git'
}
const commands = new RuntimeHostedReviewCommands({
  resolveRepo: async () => repo,
  resolveTarget: async () => ({ repo, repoPath: repo.path }),
  getExecutionOptions: () => undefined,
  recordCreated: () => {}
})
const desktopLookup: PRRefreshOutcome = {
  kind: 'found',
  pr: makePR({ number: 7, title: 'from desktop lookup', headSha: 'head-a' }),
  fetchedAt: 1
}
const freshLookup: PRRefreshOutcome = {
  kind: 'found',
  pr: makePR({ number: 7, title: 'from fresh lookup', headSha: 'head-a' }),
  fetchedAt: 2
}

beforeEach(() => {
  mocks.resolve.mockReset()
  mocks.resolve.mockResolvedValueOnce(desktopLookup).mockResolvedValue(freshLookup)
})

describe('phone PR lookups reuse the desktop’s last result', () => {
  it.each<{
    label: string
    branch: string
    headOid: string
    clientKind?: DeviceScope
    reason?: GitHubPRRefreshReason
    userRefresh?: boolean
    seedFallback?: number
    fallback?: number
    expected: string
  }>([
    {
      label: 'serves a phone read whose head is the PR head',
      branch: 'served',
      headOid: 'head-a',
      clientKind: 'mobile',
      expected: 'from desktop lookup'
    },
    {
      label: 'serves a phone read with the fallback number the PR was found by',
      branch: 'same-fallback',
      headOid: 'head-a',
      clientKind: 'mobile',
      seedFallback: 7,
      fallback: 7,
      expected: 'from desktop lookup'
    },
    {
      label: 'looks up again when the PR may have come from another fallback number',
      branch: 'other-fallback',
      headOid: 'head-a',
      clientKind: 'mobile',
      seedFallback: 7,
      expected: 'from fresh lookup'
    },
    {
      label: 'looks up again when the PR head differs',
      branch: 'moved',
      headOid: 'head-b',
      clientKind: 'mobile',
      expected: 'from fresh lookup'
    },
    {
      label: 'looks up again for a phone read with a reason',
      branch: 'reason',
      headOid: 'head-a',
      clientKind: 'mobile',
      reason: 'visible',
      expected: 'from fresh lookup'
    },
    {
      label: 'looks up again for a phone Refresh',
      branch: 'refresh',
      headOid: 'head-a',
      clientKind: 'mobile',
      userRefresh: true,
      expected: 'from fresh lookup'
    },
    {
      label: 'looks up again for a desktop caller',
      branch: 'desktop',
      headOid: 'head-a',
      clientKind: 'runtime',
      expected: 'from fresh lookup'
    }
  ])('$label', async (testCase) => {
    const { branch, headOid, clientKind, reason, userRefresh, expected } = testCase
    await commands.getRepoPRForBranch(
      repo.id,
      branch,
      null,
      testCase.seedFallback ?? null,
      false,
      'head-a',
      'visible'
    )
    const outcome = await commands.getRepoPRForBranch(
      repo.id,
      branch,
      null,
      testCase.fallback ?? null,
      false,
      headOid,
      reason,
      userRefresh,
      clientKind
    )
    expect(outcome.kind === 'found' ? outcome.pr.title : null).toBe(expected)
  })
})

describe('a slower host cadence caps every client’s timed reads', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000)
  })
  afterEach(() => {
    setPRAutoRefreshCadence('default')
    vi.useRealTimers()
  })

  it('answers a phone’s timer read (swr) from the last read while off, past the phone window', async () => {
    setPRAutoRefreshCadence('off')
    await commands.getRepoPRForBranch(
      repo.id,
      'phone-timer',
      null,
      null,
      false,
      'head-a',
      'visible'
    )
    vi.advanceTimersByTime(60_000)
    const timed = await commands.getRepoPRForBranch(
      repo.id,
      'phone-timer',
      null,
      null,
      false,
      'head-a',
      'swr',
      undefined,
      'mobile'
    )
    expect(timed.kind === 'found' ? timed.pr.title : null).toBe('from desktop lookup')
    expect(mocks.resolve).toHaveBeenCalledTimes(1)
  })

  it('reads fresh for a budgeted read marked foreground (window or screen came back) while off', async () => {
    setPRAutoRefreshCadence('off')
    await commands.getRepoPRForBranch(repo.id, 'fg', null, null, false, 'head-a', 'active')
    vi.advanceTimersByTime(2 * 60_000)
    const back = await commands.getRepoPRForBranch(
      repo.id,
      'fg',
      null,
      null,
      false,
      'head-a',
      'visible',
      undefined,
      'runtime',
      true
    )
    expect(back.kind === 'found' ? back.pr.title : null).toBe('from fresh lookup')
    expect(mocks.resolve).toHaveBeenCalledTimes(2)
  })

  it('reads fresh when the request accepts a merged fallback the cached read did not', async () => {
    setPRAutoRefreshCadence('off')
    await commands.getRepoPRForBranch(repo.id, 'accept', null, 7, false, null, 'visible')
    const accepting = await commands.getRepoPRForBranch(
      repo.id,
      'accept',
      null,
      7,
      true,
      null,
      'visible'
    )
    expect(accepting.kind === 'found' ? accepting.pr.title : null).toBe('from fresh lookup')
    expect(mocks.resolve).toHaveBeenCalledTimes(2)
  })

  it.each(['default', 'off'] as const)(
    'a paired window returning after its data is due reads fresh with the host %s',
    async (cadence) => {
      setPRAutoRefreshCadence(cadence)
      const branch = `window-return-${cadence}`
      await commands.getRepoPRForBranch(repo.id, branch, null, null, false, 'head-a', 'active')
      const scheduler = createVisibleHostedReviewRefreshScheduler()
      let title: string | undefined
      scheduler.update([
        {
          key: branch,
          revision: 'head-a',
          fetchedAt: 1_000,
          intervalMs: cadence === 'off' ? null : 60_000,
          selected: true,
          cadence,
          refresh: async (_force, _signal, foreground) => {
            const outcome = await commands.getRepoPRForBranch(
              repo.id,
              branch,
              null,
              null,
              false,
              'head-a',
              'visible',
              undefined,
              'runtime',
              foreground
            )
            title = outcome.kind === 'found' ? outcome.pr.title : undefined
            return true
          }
        }
      ])
      await vi.advanceTimersByTimeAsync(2 * 60_000)
      scheduler.setVisible(true)
      await vi.advanceTimersByTimeAsync(0)
      expect(title).toBe('from fresh lookup')
      expect(mocks.resolve).toHaveBeenCalledTimes(2)
      scheduler.dispose()
    }
  )
})
