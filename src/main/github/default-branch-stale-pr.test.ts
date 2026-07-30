/*
 * Issue #9171 — "Wrong PR diffs displayed when checking out the default branch".
 *
 * A repo's default branch is `master`. In the past someone opened a PR whose
 * HEAD was `master` (accidentally opening a PR *from* the default branch); it
 * was closed long ago. getPRForBranch looks a PR up purely by head branch name
 * with `state=all`, so without a guard that stale closed PR gets attached to
 * the default-branch checkout, surfacing its wrong diffs and checks.
 *
 * These tests assert the CORRECT behavior: an implicit (non-linked) branch or
 * fallback-number match on the repo default branch never surfaces a non-open
 * PR, while open PRs on the trunk and closed/merged PRs on feature branches
 * keep today's behavior. The default branch is resolved by the REAL
 * resolveDefaultBaseRefViaExec over the mocked git exec layer, so the
 * symbolic-ref / rev-parse plumbing and the `origin/` strip are exercised.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

type RateLimitGuardResult =
  | { blocked: false }
  | { blocked: true; remaining: number; limit: number; resetAt: number }

const {
  execFileAsyncMock,
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  getIssueOwnerRepoMock,
  getOwnerRepoForRemoteMock,
  resolvePRRepositoryCandidatesMock,
  getRemoteUrlForRepoMock,
  gitExecFileAsyncMock,
  getRateLimitMock,
  rateLimitGuardMock,
  noteRateLimitSpendMock,
  ghRepoExecOptionsMock,
  githubRepoContextMock,
  getSshGitProviderMock,
  readLocalGitConfigSignatureMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn(),
  ghExecFileAsyncMock: vi.fn(),
  getOwnerRepoMock: vi.fn(),
  getIssueOwnerRepoMock: vi.fn(),
  getOwnerRepoForRemoteMock: vi.fn(),
  resolvePRRepositoryCandidatesMock: vi.fn(),
  getRemoteUrlForRepoMock: vi.fn(),
  gitExecFileAsyncMock: vi.fn(),
  getRateLimitMock: vi.fn(),
  rateLimitGuardMock: vi.fn<(bucket?: string) => RateLimitGuardResult>(() => ({
    blocked: false
  })),
  noteRateLimitSpendMock: vi.fn(),
  ghRepoExecOptionsMock: vi.fn((context) =>
    context.connectionId
      ? {}
      : {
          cwd: context.repoPath,
          ...(context.wslDistro ? { wslDistro: context.wslDistro } : {})
        }
  ),
  githubRepoContextMock: vi.fn((repoPath, connectionId, localGitOptions) => ({
    repoPath,
    connectionId: connectionId ?? null,
    ...localGitOptions
  })),
  getSshGitProviderMock: vi.fn(),
  readLocalGitConfigSignatureMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gh-utils', () => ({
  execFileAsync: execFileAsyncMock,
  ghExecFileAsync: ghExecFileAsyncMock,
  getOwnerRepo: getOwnerRepoMock,
  getIssueOwnerRepo: getIssueOwnerRepoMock,
  getOwnerRepoForRemote: getOwnerRepoForRemoteMock,
  resolvePRRepositoryCandidates: resolvePRRepositoryCandidatesMock,
  getRemoteUrlForRepo: getRemoteUrlForRepoMock,
  gitExecFileAsync: gitExecFileAsyncMock,
  ghRepoExecOptions: ghRepoExecOptionsMock,
  githubRepoContext: githubRepoContextMock,
  classifyGhError: (stderr: string) => {
    const lower = stderr.toLowerCase()
    if (lower.includes('not found') || stderr.includes('HTTP 404')) {
      return { type: 'not_found', message: stderr }
    }
    if (lower.includes('rate limit')) {
      return { type: 'rate_limited', message: stderr }
    }
    return { type: 'unknown', message: stderr }
  },
  parseGitHubOwnerRepo: (remoteUrl: string) => {
    const match = remoteUrl.trim().match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/)
    return match ? { owner: match[1], repo: match[2] } : null
  },
  acquire: acquireMock,
  release: releaseMock,
  _resetOwnerRepoCache: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: getSshGitProviderMock
}))

vi.mock('./local-git-config-signature', () => ({
  readLocalGitConfigSignature: readLocalGitConfigSignatureMock
}))

vi.mock('./rate-limit', () => ({
  getRateLimit: getRateLimitMock,
  rateLimitGuard: rateLimitGuardMock,
  noteRateLimitSpend: noteRateLimitSpendMock
}))

import {
  getPRForBranch,
  getPRForBranchOutcome,
  _resetOwnerRepoCache,
  _resetMergeQueueCacheForTests,
  __resetTrackedUpstreamBranchCacheForTests
} from './client'
import { __resetPRConflictSummaryCachesForTests } from './conflict-summary'
import { resetMergedPRCommitMembershipCacheForTest } from './merged-pr-commit-membership'
import { __resetRepoDefaultBranchCacheForTests } from '../source-control/repo-default-branch'

const DEFAULT_BRANCH_REF = 'refs/remotes/origin/master'

/**
 * Answer the real resolveDefaultBaseRefViaExec probes (origin/HEAD
 * symbolic-ref + rev-parse verification), the merged-at-head `rev-parse HEAD`
 * probe, and the tracked-upstream `for-each-ref` snapshot.
 */
function primeGitExecForDefaultBranch({
  defaultRef = DEFAULT_BRANCH_REF,
  headOid = 'checkout-head-oid'
}: { defaultRef?: string; headOid?: string } = {}): void {
  gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'symbolic-ref' && args.includes('refs/remotes/origin/HEAD')) {
      return { stdout: `${defaultRef}\n`, stderr: '' }
    }
    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      if (args.includes(defaultRef)) {
        return { stdout: 'default-branch-oid\n', stderr: '' }
      }
      throw new Error(`fatal: Needed a single revision: ${args.join(' ')}`)
    }
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      return { stdout: `${headOid}\n`, stderr: '' }
    }
    if (args[0] === 'for-each-ref') {
      return { stdout: '', stderr: '' }
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`)
  })
}

type RestPRShape = {
  number?: number
  state?: string
  merged_at?: string | null
  head_ref?: string
  head_sha?: string
}

function restPR({
  number = 7,
  state = 'closed',
  merged_at = null,
  head_ref = 'master',
  head_sha = 'stale-master-oid'
}: RestPRShape = {}): Record<string, unknown> {
  return {
    number,
    title: 'Historical PR',
    state,
    merged_at,
    html_url: `https://github.com/acme/widgets/pull/${number}`,
    updated_at: '2024-01-01T00:00:00Z',
    draft: false,
    mergeable: null,
    base: { ref: 'old-release', sha: 'base-oid' },
    head: { ref: head_ref, sha: head_sha }
  }
}

/** Route the REST head-branch lookup; every other gh call fails so branch data
 *  is kept as-is (hydration falls back to the branch payload). */
function primeGhExecWithBranchList(list: Record<string, unknown>[]): void {
  ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'api' && args[1]?.includes('pulls?head=')) {
      return { stdout: JSON.stringify(list) }
    }
    throw new Error(`gh unavailable: ${args.join(' ')}`)
  })
}

describe('issue #9171: default-branch checkout must not attach a stale non-open PR', () => {
  beforeEach(() => {
    execFileAsyncMock.mockReset()
    ghExecFileAsyncMock.mockReset()
    getOwnerRepoMock.mockReset()
    getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    getIssueOwnerRepoMock.mockReset()
    getOwnerRepoForRemoteMock.mockReset()
    // Why: getPRForBranch resolves origin through getOwnerRepoForRemote.
    getOwnerRepoForRemoteMock.mockImplementation(
      async (repoPath: string, remoteName: string, connectionId?: string | null, opts = {}) =>
        remoteName === 'origin' ? getOwnerRepoMock(repoPath, connectionId, opts) : null
    )
    resolvePRRepositoryCandidatesMock.mockReset()
    resolvePRRepositoryCandidatesMock.mockImplementation(async (repoPath, connectionId) => {
      const origin = await getOwnerRepoMock(repoPath, connectionId)
      return { candidates: origin ? [origin] : [], headRepo: origin }
    })
    getRemoteUrlForRepoMock.mockReset()
    gitExecFileAsyncMock.mockReset()
    getRateLimitMock.mockReset()
    getRateLimitMock.mockResolvedValue({ resources: {} })
    rateLimitGuardMock.mockReset()
    rateLimitGuardMock.mockReturnValue({ blocked: false })
    noteRateLimitSpendMock.mockReset()
    ghRepoExecOptionsMock.mockClear()
    githubRepoContextMock.mockClear()
    getSshGitProviderMock.mockReset()
    readLocalGitConfigSignatureMock.mockReset()
    readLocalGitConfigSignatureMock.mockResolvedValue(undefined)
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    _resetOwnerRepoCache()
    _resetMergeQueueCacheForTests()
    __resetTrackedUpstreamBranchCacheForTests()
    __resetPRConflictSummaryCachesForTests()
    resetMergedPRCommitMembershipCacheForTest()
    __resetRepoDefaultBranchCacheForTests()
  })

  it('hides a stale CLOSED PR when checked out on the default branch (master)', async () => {
    primeGitExecForDefaultBranch()
    primeGhExecWithBranchList([restPR({ number: 7, state: 'closed' })])

    const pr = await getPRForBranch('/repo-root', 'master')

    // The head-branch lookup still runs (state=all) and sees the closed PR…
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['api', 'repos/acme/widgets/pulls?head=acme%3Amaster&state=all&per_page=1'],
      { cwd: '/repo-root', host: 'github.com' }
    )
    // …but the default-branch guard discards it: no PR on the trunk (#9171).
    expect(pr).toBeNull()
  })

  it('reports kind="no-pr" from getPRForBranchOutcome on the default branch', async () => {
    primeGitExecForDefaultBranch()
    primeGhExecWithBranchList([restPR({ number: 7, state: 'closed' })])

    const outcome = await getPRForBranchOutcome('/repo-root', 'master')

    expect(outcome.kind).toBe('no-pr')
  })

  it('keeps a genuinely OPEN PR on the default branch visible', async () => {
    primeGitExecForDefaultBranch()
    primeGhExecWithBranchList([restPR({ number: 8, state: 'open' })])

    const pr = await getPRForBranch('/repo-root', 'master')

    expect(pr?.number).toBe(8)
    expect(pr?.state).toBe('open')
    // Open results never consult git for the default branch (lazy resolution).
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('keeps a CLOSED PR on a feature branch visible (behavior preserved)', async () => {
    primeGitExecForDefaultBranch()
    primeGhExecWithBranchList([
      restPR({ number: 9, state: 'closed', head_ref: 'feature-x', head_sha: 'feature-oid' })
    ])

    const pr = await getPRForBranch('/repo-root', 'feature-x')

    expect(pr?.number).toBe(9)
    expect(pr?.state).toBe('closed')
  })

  it('preserves the merged-at-head carve-out on a feature branch', async () => {
    // Worktree HEAD is exactly the merged PR's final head commit.
    primeGitExecForDefaultBranch({ headOid: 'merged-head-oid' })
    primeGhExecWithBranchList([
      restPR({
        number: 10,
        state: 'closed',
        merged_at: '2024-02-02T00:00:00Z',
        head_ref: 'feature-x',
        head_sha: 'merged-head-oid'
      })
    ])

    const pr = await getPRForBranch('/repo-root', 'feature-x')

    expect(pr?.number).toBe(10)
    expect(pr?.state).toBe('merged')
  })

  it('hides a CLOSED fallback-number PR on the default branch (self-heal for persisted stale PRs)', async () => {
    primeGitExecForDefaultBranch()
    ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'api' && args[1]?.includes('pulls?head=')) {
        return { stdout: '[]' }
      }
      if (args[0] === 'pr' && args[1] === 'view' && args[2] === '7') {
        return {
          stdout: JSON.stringify({
            number: 7,
            title: 'Historical PR',
            state: 'CLOSED',
            url: 'https://github.com/acme/widgets/pull/7',
            statusCheckRollup: [],
            updatedAt: '2024-01-01T00:00:00Z',
            isDraft: false,
            mergeable: 'UNKNOWN',
            baseRefName: 'old-release',
            headRefName: 'master',
            baseRefOid: 'base-oid',
            headRefOid: 'stale-master-oid'
          })
        }
      }
      throw new Error(`gh unavailable: ${args.join(' ')}`)
    })

    const outcome = await getPRForBranchOutcome('/repo-root', 'master', null, null, 7)

    expect(outcome.kind).toBe('no-pr')
  })

  it('overrides acceptMergedFallbackPR preservation for a merged fallback PR on the default branch', async () => {
    primeGitExecForDefaultBranch()
    ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'api' && args[1]?.includes('pulls?head=')) {
        return { stdout: '[]' }
      }
      if (args[0] === 'pr' && args[1] === 'view' && args[2] === '7') {
        return {
          stdout: JSON.stringify({
            number: 7,
            title: 'Historical PR',
            state: 'MERGED',
            url: 'https://github.com/acme/widgets/pull/7',
            statusCheckRollup: [],
            updatedAt: '2024-01-01T00:00:00Z',
            isDraft: false,
            mergeable: 'UNKNOWN',
            baseRefName: 'old-release',
            headRefName: 'master',
            baseRefOid: 'base-oid',
            headRefOid: 'stale-master-oid'
          })
        }
      }
      throw new Error(`gh unavailable: ${args.join(' ')}`)
    })

    const outcome = await getPRForBranchOutcome('/repo-root', 'master', null, null, 7, {
      acceptMergedFallbackPR: true
    })

    expect(outcome.kind).toBe('no-pr')
  })

  it('fails open when the default branch cannot be resolved (stale PR still returned)', async () => {
    // Every git probe fails: no origin/HEAD, no main/master refs.
    gitExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      if (args[0] === 'for-each-ref') {
        return { stdout: '', stderr: '' }
      }
      throw new Error(`fatal: git unavailable: ${args.join(' ')}`)
    })
    primeGhExecWithBranchList([restPR({ number: 7, state: 'closed' })])

    const pr = await getPRForBranch('/repo-root', 'master')

    expect(pr?.number).toBe(7)
    expect(pr?.state).toBe('closed')
  })
})
