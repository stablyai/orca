import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initStatsPath, StatsCollector } from '../../../stats/collector'
import type { PreparedPRBranchRead } from '../../../github/client/lookup/pr-for-branch-outcome'
import type * as GithubRepositoryIdentityModule from '../../../github/repositories/github-repository-identity'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  GitHubPRRefreshReason,
  PRRefreshOutcome
} from '../../../../shared/github/pull-requests/refresh/pull-request-refresh-types'
import type {
  GitHubRepoContext,
  LocalGitExecOptions
} from '../../../github/repositories/github-repository-identity'
import type { Repo } from '../../../../shared/repo-types'
import type { DeviceScope } from '../../../../shared/runtime-session-contracts'
import { makePR } from '../../../github/pull-requests/refresh/pr-refresh-coordinator-test-harness'

const mocks = vi.hoisted(() => ({ resolve: vi.fn() }))
vi.mock('../../../github/execution/github-operation-slots', () => ({
  acquire: vi.fn(async () => {}),
  release: vi.fn()
}))

vi.mock('../../../github/repositories/github-repository-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof GithubRepositoryIdentityModule>()),
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
vi.mock('../../../github/pull-requests/refresh/pr-refresh-coordinator', () => ({
  runHostedPRSnapshot: (_candidate: unknown, read: PreparedPRBranchRead) => read.read(),
  runHostedPRRead: (
    _candidate: unknown,
    read: (() => Promise<PRRefreshOutcome>) | PreparedPRBranchRead
  ) => (typeof read === 'function' ? read() : read.read())
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
    expect('kind' in outcome && outcome.kind === 'found' ? outcome.pr.title : null).toBe(expected)
  })
})

it.each([undefined, 'visible', 'swr'] as const)(
  'counts PRs discovered by mobile lookups with reason %s once',
  async (reason) => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-mobile-pr-stats-'))
    initStatsPath(directory)
    const stats = new StatsCollector()
    const mobileCommands = new RuntimeHostedReviewCommands({
      resolveRepo: async () => repo,
      resolveTarget: async () => ({ repo, repoPath: repo.path }),
      getExecutionOptions: () => undefined,
      recordCreated: (repoId, number, url) => {
        if (!stats.hasCountedPR(url)) {
          stats.record({
            type: 'pr_created',
            at: 1,
            repoId,
            meta: { prNumber: number, prUrl: url }
          })
        }
      }
    })
    try {
      if (reason === undefined) {
        await commands.getRepoPRForBranch(
          repo.id,
          `stats-${reason}`,
          null,
          null,
          false,
          'head-a',
          'visible'
        )
      }
      for (let index = 0; index < 2; index++) {
        await mobileCommands.getRepoPRForBranch(
          repo.id,
          `stats-${reason}`,
          null,
          null,
          false,
          'head-a',
          reason,
          false,
          'mobile'
        )
      }
      expect(stats.getSummary().totalPRsCreated).toBe(1)
    } finally {
      await stats.flushAsync()
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
