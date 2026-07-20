/* oxlint-disable max-lines -- Why: GitHub client fixtures cover local and SSH repo identity paths in one suite so mocked CLI behavior stays consistent. */
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
  checkOrcaStarred,
  getPRComments,
  getPRForBranch,
  getPRForBranchOutcome,
  getRepoSlug,
  getRepoUpstream,
  getWorkItem,
  getPullRequestPushTarget,
  mergePR,
  resolveReviewThread,
  setPRAutoMerge,
  updatePRState,
  updatePRTitle,
  _getMergeQueueCacheSizeForTests,
  _getTrackedUpstreamBranchCacheSizesForTests,
  _resetOwnerRepoCache,
  _resetMergeQueueCacheForTests,
  __resetTrackedUpstreamBranchCacheForTests
} from './client'
import { __resetPRConflictSummaryCachesForTests } from './conflict-summary'
import { resetMergedPRCommitMembershipCacheForTest } from './merged-pr-commit-membership'

describe('checkOrcaStarred', () => {
  beforeEach(() => {
    execFileAsyncMock.mockReset()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
  })

  it('returns true only for an included successful GitHub response', async () => {
    execFileAsyncMock.mockResolvedValueOnce({ stdout: 'HTTP/2.0 204 No Content\r\n', stderr: '' })

    await expect(checkOrcaStarred()).resolves.toBe(true)

    expect(execFileAsyncMock).toHaveBeenCalledWith(
      'gh',
      ['api', '--include', 'user/starred/stablyai/orca'],
      { encoding: 'utf-8' }
    )
  })

  it('returns true for an HTTP 200 starred response', async () => {
    execFileAsyncMock.mockResolvedValueOnce({ stdout: 'HTTP/2.0 200 OK\r\n', stderr: '' })

    await expect(checkOrcaStarred()).resolves.toBe(true)
  })

  it('returns false for GitHub 404 not starred responses', async () => {
    execFileAsyncMock.mockRejectedValueOnce(new Error('HTTP 404: Not Found'))

    await expect(checkOrcaStarred()).resolves.toBe(false)
  })

  it('returns null when gh exits successfully without response headers', async () => {
    execFileAsyncMock.mockResolvedValueOnce({ stdout: '', stderr: '' })

    await expect(checkOrcaStarred()).resolves.toBe(null)
  })
})

describe('getPRForBranch', () => {
  beforeEach(() => {
    execFileAsyncMock.mockReset()
    ghExecFileAsyncMock.mockReset()
    getOwnerRepoMock.mockReset()
    getIssueOwnerRepoMock.mockReset()
    getOwnerRepoForRemoteMock.mockReset()
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
  })

  it('queries GitHub by head branch when the remote is on github.com', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 42,
          title: 'Fix PR discovery',
          state: 'open',
          html_url: 'https://github.com/acme/widgets/pull/42',
          updated_at: '2026-03-28T00:00:00Z',
          draft: false,
          mergeable: true,
          base: { ref: 'main', sha: 'base-oid' },
          head: { ref: 'feature/test', sha: 'head-oid' }
        }
      ])
    })

    const pr = await getPRForBranch('/repo-root', 'refs/heads/feature/test')

    expect(getOwnerRepoMock).toHaveBeenCalledWith('/repo-root', undefined)
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['api', 'repos/acme/widgets/pulls?head=acme%3Afeature%2Ftest&state=all&per_page=1'],
      { cwd: '/repo-root' }
    )
    expect(pr?.number).toBe(42)
    expect(pr?.state).toBe('open')
    expect(pr?.mergeable).toBe('MERGEABLE')
    expect(pr?.prRepo).toEqual({ owner: 'acme', repo: 'widgets' })
    expect(pr?.headRepo).toEqual({ owner: 'acme', repo: 'widgets' })
  })

  it('resolves fork PRs from the upstream PR repo with the origin head owner', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [
        { owner: 'stablyai', repo: 'orca' },
        { owner: 'fork', repo: 'orca' }
      ],
      headRepo: { owner: 'fork', repo: 'orca' }
    })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 1738,
          title: 'Fork PR',
          state: 'open',
          html_url: 'https://github.com/stablyai/orca/pull/1738',
          updated_at: '2026-03-28T00:00:00Z',
          draft: false,
          mergeable_state: 'clean',
          base: { ref: 'main', sha: 'base-oid' },
          head: { ref: 'feature/test', sha: 'head-oid' }
        }
      ])
    })

    const pr = await getPRForBranch('/repo-root', 'feature/test')

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['api', 'repos/stablyai/orca/pulls?head=fork%3Afeature%2Ftest&state=all&per_page=1'],
      { cwd: '/repo-root' }
    )
    expect(pr).toMatchObject({
      number: 1738,
      prRepo: { owner: 'stablyai', repo: 'orca' },
      headRepo: { owner: 'fork', repo: 'orca' }
    })
  })

  it('looks up a linked PR number across PR repo candidates', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [
        { owner: 'stablyai', repo: 'orca' },
        { owner: 'fork', repo: 'orca' }
      ],
      headRepo: { owner: 'fork', repo: 'orca' }
    })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'linked-head-oid\n', stderr: '' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('HTTP 404: Not Found'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 99,
          title: 'Linked fork PR',
          state: 'OPEN',
          url: 'https://github.com/fork/orca/pull/99',
          statusCheckRollup: [],
          updatedAt: '2026-03-28T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'feature/test',
          baseRefOid: 'base-oid',
          headRefOid: 'linked-head-oid'
        })
      })

    const pr = await getPRForBranch('/repo-root', 'feature/test', 99)

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      [
        'pr',
        'view',
        '99',
        '--repo',
        'stablyai/orca',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid'
      ],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      [
        'pr',
        'view',
        '99',
        '--repo',
        'fork/orca',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid'
      ],
      { cwd: '/repo-root' }
    )
    expect(pr?.prRepo).toEqual({ owner: 'fork', repo: 'orca' })
  })

  it('prefers exact linked PR lookup when the repo identity is known', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'linked-head-oid\n', stderr: '' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 99,
        title: 'Linked PR',
        state: 'OPEN',
        url: 'https://github.com/acme/widgets/pull/99',
        statusCheckRollup: [],
        updatedAt: '2026-03-28T00:00:00Z',
        isDraft: false,
        mergeable: 'MERGEABLE',
        baseRefName: 'main',
        headRefName: 'someone/fix',
        baseRefOid: 'base-oid',
        headRefOid: 'linked-head-oid'
      })
    })

    const pr = await getPRForBranch('/repo-root', 'feature/local-worktree', 99)

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'pr',
        'view',
        '99',
        '--repo',
        'acme/widgets',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid'
      ],
      { cwd: '/repo-root' }
    )
    expect(pr).toMatchObject({
      number: 99,
      title: 'Linked PR',
      state: 'open',
      headSha: 'linked-head-oid'
    })
  })

  it('hydrates repository merge method settings for exact PR lookups', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 99,
          title: 'Linked PR',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/pull/99',
          statusCheckRollup: [],
          updatedAt: '2026-03-28T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          reviewDecision: 'APPROVED',
          mergeStateStatus: 'CLEAN',
          autoMergeRequest: null,
          baseRefName: 'main',
          headRefName: 'someone/fix',
          baseRefOid: 'base-oid',
          headRefOid: 'linked-head-oid'
        })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          data: {
            repository: {
              viewerDefaultMergeMethod: 'REBASE',
              mergeCommitAllowed: false,
              rebaseMergeAllowed: true,
              squashMergeAllowed: true,
              autoMergeAllowed: true,
              mergeQueue: null
            }
          }
        })
      })

    const pr = await getPRForBranch('/repo-root', 'feature/local-worktree', 99)

    expect(pr?.mergeMethodSettings).toEqual({
      defaultMethod: 'rebase',
      allowedMethods: {
        squash: true,
        merge: false,
        rebase: true
      }
    })
    expect(pr?.mergeQueueRequired).toBe(false)
    expect(pr?.autoMergeAllowed).toBe(true)
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining([
        'api',
        'graphql',
        '-f',
        'owner=acme',
        '-f',
        'repo=widgets',
        '-f',
        'branch=main'
      ]),
      { cwd: '/repo-root' }
    )
  })

  it('treats linked PR metadata as authoritative even when the branch head differs', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'current-worktree-head\n', stderr: '' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 99,
          title: 'Stale linked PR',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/pull/99',
          statusCheckRollup: [],
          updatedAt: '2026-03-28T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'someone/other-work',
          baseRefOid: 'base-oid',
          headRefOid: 'stale-linked-head'
        })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 42,
            title: 'Branch PR',
            state: 'OPEN',
            url: 'https://github.com/acme/widgets/pull/42',
            statusCheckRollup: [],
            updatedAt: '2026-03-28T00:00:00Z',
            isDraft: false,
            mergeable: 'MERGEABLE',
            baseRefName: 'main',
            headRefName: 'feature/test',
            baseRefOid: 'base-oid',
            headRefOid: 'current-worktree-head'
          }
        ])
      })

    const pr = await getPRForBranch('/repo-root', 'feature/test', 99)

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(pr?.number).toBe(99)
  })

  it('does not fall back to branch discovery when linked PR metadata is stale', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('HTTP 404: Not Found'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 42,
            title: 'Branch PR',
            state: 'OPEN',
            url: 'https://github.com/acme/widgets/pull/42',
            statusCheckRollup: [],
            updatedAt: '2026-03-28T00:00:00Z',
            isDraft: false,
            mergeable: 'MERGEABLE',
            baseRefName: 'main',
            headRefName: 'feature/test',
            baseRefOid: 'base-oid',
            headRefOid: 'head-oid'
          }
        ])
      })

    const pr = await getPRForBranch('/repo-root', 'feature/test', 99)

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      [
        'pr',
        'view',
        '99',
        '--repo',
        'acme/widgets',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid'
      ],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(pr).toBeNull()
  })

  it('returns no PR when linked PR REST fallback also misses', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('GraphQL: could not resolve to PullRequest'))
      .mockRejectedValueOnce(new Error('HTTP 404: Not Found'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 42,
            title: 'Branch PR after stale linked miss',
            state: 'OPEN',
            url: 'https://github.com/acme/widgets/pull/42',
            statusCheckRollup: [],
            updatedAt: '2026-03-28T00:00:00Z',
            isDraft: false,
            mergeable: 'MERGEABLE',
            baseRefName: 'main',
            headRefName: 'feature/test',
            baseRefOid: 'base-oid',
            headRefOid: 'head-oid'
          }
        ])
      })

    const pr = await getPRForBranch('/repo-root', 'feature/test', 99)

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(2, ['api', 'repos/acme/widgets/pulls/99'], {
      cwd: '/repo-root'
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(pr).toBeNull()
  })

  it('returns no PR when linked PR REST fallback has an unclassified failure', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('GraphQL: server exploded'))
      .mockRejectedValueOnce(new Error('HTTP 500: server error'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 42,
            title: 'Branch PR after exact lookup outage',
            state: 'OPEN',
            url: 'https://github.com/acme/widgets/pull/42',
            statusCheckRollup: [],
            updatedAt: '2026-03-28T00:00:00Z',
            isDraft: false,
            mergeable: 'MERGEABLE',
            baseRefName: 'main',
            headRefName: 'feature/test',
            baseRefOid: 'base-oid',
            headRefOid: 'head-oid'
          }
        ])
      })

    const pr = await getPRForBranch('/repo-root', 'feature/test', 99)

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(2, ['api', 'repos/acme/widgets/pulls/99'], {
      cwd: '/repo-root'
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(pr).toBeNull()
  })

  it('does not continue to branch discovery when linked PR REST fallback is rate limited', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('GraphQL: API rate limit already exceeded'))
      .mockRejectedValueOnce(new Error('REST API rate limit already exceeded'))

    const pr = await getPRForBranch('/repo-root', 'feature/test', 99)

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      [
        'pr',
        'view',
        '99',
        '--repo',
        'acme/widgets',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid'
      ],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(2, ['api', 'repos/acme/widgets/pulls/99'], {
      cwd: '/repo-root'
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(pr).toBeNull()
  })

  it('uses REST branch lookup directly when origin head repo is known', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 43,
          title: 'REST branch lookup',
          state: 'open',
          html_url: 'https://github.com/acme/widgets/pull/43',
          updated_at: '2026-03-28T00:00:00Z',
          draft: false,
          mergeable: true,
          head: { ref: 'feature/test', sha: 'rest-head-oid' },
          base: { ref: 'main', sha: 'rest-base-oid' }
        }
      ])
    })

    const pr = await getPRForBranch('/repo-root', 'feature/test')

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      ['api', 'repos/acme/widgets/pulls?head=acme%3Afeature%2Ftest&state=all&per_page=1'],
      { cwd: '/repo-root' }
    )
    expect(pr).toMatchObject({
      number: 43,
      title: 'REST branch lookup',
      state: 'open',
      url: 'https://github.com/acme/widgets/pull/43',
      checksStatus: 'neutral',
      mergeable: 'MERGEABLE',
      headSha: 'rest-head-oid'
    })
  })

  it('ignores merged PRs discovered only by branch lookup when the branch moved on', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 5511,
            title: 'Merged branch PR',
            state: 'closed',
            merged_at: '2026-06-16T17:15:33Z',
            html_url: 'https://github.com/stablyai/orca/pull/5511',
            updated_at: '2026-06-16T17:15:33Z',
            draft: false,
            mergeable_state: 'clean',
            head: { ref: 'add-guide-for-mobile-emulator-use', sha: 'head-oid' },
            base: { ref: 'main', sha: 'base-oid' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 5511,
          title: 'Merged branch PR',
          state: 'MERGED',
          url: 'https://github.com/stablyai/orca/pull/5511',
          statusCheckRollup: [],
          updatedAt: '2026-06-16T17:15:33Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'add-guide-for-mobile-emulator-use',
          baseRefOid: 'base-oid',
          headRefOid: 'head-oid'
        })
      })
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'new-local-head-oid\n',
      stderr: ''
    })

    const pr = await getPRForBranch('/repo-root', 'add-guide-for-mobile-emulator-use')

    expect(pr).toBeNull()
  })

  it('shows a merged branch PR when it still matches the current HEAD', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 5875,
            title: 'Merged current branch PR',
            state: 'closed',
            merged_at: '2026-06-20T04:53:05Z',
            html_url: 'https://github.com/acme/widgets/pull/5875',
            updated_at: '2026-06-20T04:53:05Z',
            draft: false,
            mergeable_state: 'clean',
            head: { ref: 'fix-tab-strip-layout-test', sha: 'current-head-oid' },
            base: { ref: 'main', sha: 'base-oid' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 5875,
          title: 'Merged current branch PR',
          state: 'MERGED',
          url: 'https://github.com/acme/widgets/pull/5875',
          statusCheckRollup: [],
          updatedAt: '2026-06-20T04:53:05Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'fix-tab-strip-layout-test',
          baseRefOid: 'base-oid',
          headRefOid: 'current-head-oid'
        })
      })
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'current-head-oid\n',
      stderr: ''
    })

    const pr = await getPRForBranch('/repo-root', 'fix-tab-strip-layout-test')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(['rev-parse', 'HEAD'], {
      cwd: '/repo-root'
    })
    expect(pr).toMatchObject({
      number: 5875,
      title: 'Merged current branch PR',
      state: 'merged',
      headSha: 'current-head-oid'
    })
  })

  const mockMergedBranchPRLookupBehindHead = (prNumber = 6011): void => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: prNumber,
            title: 'Merged PR with unpulled final head',
            state: 'closed',
            merged_at: '2026-07-03T21:27:36Z',
            html_url: `https://github.com/acme/widgets/pull/${prNumber}`,
            updated_at: '2026-07-03T21:27:36Z',
            draft: false,
            mergeable_state: 'clean',
            head: { ref: 'fix-hibernation-wake', sha: 'aaaa1111aaaa1111' },
            base: { ref: 'main', sha: 'base-oid' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: prNumber,
          title: 'Merged PR with unpulled final head',
          state: 'MERGED',
          url: `https://github.com/acme/widgets/pull/${prNumber}`,
          statusCheckRollup: [],
          updatedAt: '2026-07-03T21:27:36Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'fix-hibernation-wake',
          baseRefOid: 'base-oid',
          headRefOid: 'aaaa1111aaaa1111'
        })
      })
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'bbbb2222bbbb2222\n',
      stderr: ''
    })
  }

  it('shows a merged branch PR when the worktree head is one of its own commits', async () => {
    mockMergedBranchPRLookupBehindHead()
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([{ number: 6011 }, { number: 42 }])
    })

    const pr = await getPRForBranch('/repo-root', 'fix-hibernation-wake')

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      ['api', 'repos/acme/widgets/commits/bbbb2222bbbb2222/pulls?per_page=100&page=1'],
      expect.anything()
    )
    expect(pr).toMatchObject({
      number: 6011,
      state: 'merged',
      headSha: 'aaaa1111aaaa1111',
      confirmedContainedHeadOid: 'bbbb2222bbbb2222'
    })
  })

  it('keeps hiding a merged branch PR when the head belongs to a different PR (reused branch)', async () => {
    mockMergedBranchPRLookupBehindHead()
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([{ number: 42 }])
    })

    const pr = await getPRForBranch('/repo-root', 'fix-hibernation-wake')

    expect(pr).toBeNull()
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(3)

    // A definitive "not part of this PR" answer is immutable for a merged PR:
    // repeated polls must not re-probe GitHub.
    mockMergedBranchPRLookupBehindHead()
    const second = await getPRForBranch('/repo-root', 'fix-hibernation-wake')

    expect(second).toBeNull()
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(5)
  })

  it('keeps hiding a merged branch PR when the commit membership probe fails', async () => {
    mockMergedBranchPRLookupBehindHead()
    ghExecFileAsyncMock.mockRejectedValueOnce(new Error('HTTP 422: No commit found'))

    const pr = await getPRForBranch('/repo-root', 'fix-hibernation-wake')

    expect(pr).toBeNull()
  })

  it('skips the membership probe while the core rate-limit budget is blocked', async () => {
    mockMergedBranchPRLookupBehindHead()
    rateLimitGuardMock.mockImplementation((bucket?: string) =>
      bucket === 'core'
        ? { blocked: true, remaining: 0, limit: 5000, resetAt: 0 }
        : { blocked: false }
    )

    const pr = await getPRForBranch('/repo-root', 'fix-hibernation-wake')

    expect(pr).toBeNull()
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
  })

  it('reuses the cached membership answer instead of re-querying per poll', async () => {
    mockMergedBranchPRLookupBehindHead()
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([{ number: 6011 }])
    })
    const first = await getPRForBranch('/repo-root', 'fix-hibernation-wake')
    expect(first).toMatchObject({ number: 6011, confirmedContainedHeadOid: 'bbbb2222bbbb2222' })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(3)

    mockMergedBranchPRLookupBehindHead()
    const second = await getPRForBranch('/repo-root', 'fix-hibernation-wake')

    expect(second).toMatchObject({ number: 6011, confirmedContainedHeadOid: 'bbbb2222bbbb2222' })
    // No fourth membership call: the confirmed answer is immutable and cached.
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(5)
  })

  it('uses the caller-supplied worktree head for the membership probe without shelling out', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 6012,
            title: 'Merged PR queried by checks panel',
            state: 'closed',
            merged_at: '2026-07-03T21:27:36Z',
            html_url: 'https://github.com/acme/widgets/pull/6012',
            updated_at: '2026-07-03T21:27:36Z',
            draft: false,
            mergeable_state: 'clean',
            head: { ref: 'fix-hibernation-wake', sha: 'aaaa1111aaaa1111' },
            base: { ref: 'main', sha: 'base-oid' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 6012,
          title: 'Merged PR queried by checks panel',
          state: 'MERGED',
          url: 'https://github.com/acme/widgets/pull/6012',
          statusCheckRollup: [],
          updatedAt: '2026-07-03T21:27:36Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'fix-hibernation-wake',
          baseRefOid: 'base-oid',
          headRefOid: 'aaaa1111aaaa1111'
        })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([{ number: 6012 }])
      })

    const outcome = await getPRForBranchOutcome(
      '/repo-root',
      'fix-hibernation-wake',
      null,
      null,
      null,
      {
        currentHeadOid: 'cccc3333cccc3333'
      }
    )

    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(outcome).toMatchObject({
      kind: 'found',
      pr: {
        number: 6012,
        headRefName: 'fix-hibernation-wake',
        confirmedContainedHeadOid: 'cccc3333cccc3333'
      }
    })
  })

  function mockMergedLinkedPRLookup(prNumber = 7447) {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [{ owner: 'acme', repo: 'widgets' }],
      headRepo: { owner: 'acme', repo: 'widgets' }
    })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: prNumber,
        title: 'Merged linked PR',
        state: 'MERGED',
        url: `https://github.com/acme/widgets/pull/${prNumber}`,
        statusCheckRollup: [],
        updatedAt: '2026-07-03T21:27:36Z',
        isDraft: false,
        mergeable: 'MERGEABLE',
        baseRefName: 'main',
        headRefName: 'old-linked-branch',
        baseRefOid: 'base-oid',
        headRefOid: 'aaaa1111aaaa1111'
      })
    })
  }

  it('stamps confirmedContainedHeadOid for a linked merged PR when HEAD is its commit', async () => {
    mockMergedLinkedPRLookup()
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([{ number: 7447 }])
    })

    const outcome = await getPRForBranchOutcome('/repo-root', 'new-work', 7447, null, null, {
      currentHeadOid: 'bbbb2222bbbb2222'
    })

    expect(outcome).toMatchObject({
      kind: 'found',
      pr: {
        number: 7447,
        state: 'merged',
        confirmedContainedHeadOid: 'bbbb2222bbbb2222'
      }
    })
    expect(outcome.kind === 'found' ? outcome.pr.headDivergedFromMergedPRAtOid : undefined).toBe(
      undefined
    )
  })

  it('stamps headDivergedFromMergedPRAtOid for a linked merged PR with a definite miss', async () => {
    mockMergedLinkedPRLookup()
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([{ number: 42 }])
    })

    const outcome = await getPRForBranchOutcome('/repo-root', 'new-work', 7447, null, null, {
      currentHeadOid: 'bbbb2222bbbb2222'
    })

    expect(outcome).toMatchObject({
      kind: 'found',
      pr: {
        number: 7447,
        state: 'merged',
        headDivergedFromMergedPRAtOid: 'bbbb2222bbbb2222'
      }
    })
  })

  it('stamps linked merged divergence when a later membership page proves absence', async () => {
    mockMergedLinkedPRLookup()
    // Page 1 is full and omits the linked PR (truncated), but page 2 is short and
    // still omits it — that pair definitively proves the head is not contained.
    const fullPage = Array.from({ length: 100 }, (_, index) => ({ number: 1000 + index }))
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify(fullPage) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ number: 2000 }]) })

    const outcome = await getPRForBranchOutcome('/repo-root', 'new-work', 7447, null, null, {
      currentHeadOid: 'bbbb2222bbbb2222'
    })

    expect(outcome).toMatchObject({
      kind: 'found',
      pr: { number: 7447, state: 'merged', headDivergedFromMergedPRAtOid: 'bbbb2222bbbb2222' }
    })
  })

  it('leaves linked merged divergence unset when membership pages stay full to the cap', async () => {
    mockMergedLinkedPRLookup()
    // Every page up to the cap is full and omits the linked PR, so absence can
    // never be proven — the probe must stay unknown rather than clear the link.
    const fullPage = Array.from({ length: 100 }, (_, index) => ({ number: 1000 + index }))
    for (let page = 0; page < 5; page += 1) {
      ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: JSON.stringify(fullPage) })
    }

    const outcome = await getPRForBranchOutcome('/repo-root', 'new-work', 7447, null, null, {
      currentHeadOid: 'bbbb2222bbbb2222'
    })

    expect(outcome).toMatchObject({ kind: 'found', pr: { number: 7447, state: 'merged' } })
    expect(outcome.kind === 'found' ? outcome.pr.headDivergedFromMergedPRAtOid : undefined).toBe(
      undefined
    )
  })

  it('stamps linked merged divergence via the PR url when no repo candidates resolve', async () => {
    // Fallback path: no resolved candidates, so `gh pr view` returns the PR with
    // dataRepo=null. The membership probe must still run against the repo derived
    // from the PR's own URL so a diverged merged linked PR can clear.
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({ candidates: [], headRepo: null })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 7447,
          title: 'Merged linked PR',
          state: 'MERGED',
          url: 'https://github.com/acme/widgets/pull/7447',
          statusCheckRollup: [],
          updatedAt: '2026-07-03T21:27:36Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'old-linked-branch',
          baseRefOid: 'base-oid',
          headRefOid: 'aaaa1111aaaa1111'
        })
      })
      .mockResolvedValueOnce({ stdout: JSON.stringify([{ number: 2000 }]) })

    const outcome = await getPRForBranchOutcome('/repo-root', 'new-work', 7447, null, null, {
      currentHeadOid: 'bbbb2222bbbb2222'
    })

    expect(outcome).toMatchObject({
      kind: 'found',
      pr: { number: 7447, state: 'merged', headDivergedFromMergedPRAtOid: 'bbbb2222bbbb2222' }
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['api', 'repos/acme/widgets/commits/bbbb2222bbbb2222/pulls?per_page=100&page=1'],
      expect.anything()
    )
  })

  it('leaves linked merged divergence unset when the membership probe is rate-limited', async () => {
    mockMergedLinkedPRLookup()
    rateLimitGuardMock.mockImplementation((bucket?: string) =>
      bucket === 'core'
        ? { blocked: true, remaining: 0, limit: 5000, resetAt: 0 }
        : { blocked: false }
    )

    const outcome = await getPRForBranchOutcome('/repo-root', 'new-work', 7447, null, null, {
      currentHeadOid: 'bbbb2222bbbb2222'
    })

    expect(outcome).toMatchObject({ kind: 'found', pr: { number: 7447, state: 'merged' } })
    expect(outcome.kind === 'found' ? outcome.pr.headDivergedFromMergedPRAtOid : undefined).toBe(
      undefined
    )
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('leaves linked merged divergence unset when the membership probe throws', async () => {
    mockMergedLinkedPRLookup()
    ghExecFileAsyncMock.mockRejectedValueOnce(new Error('HTTP 422: No commit found'))

    const outcome = await getPRForBranchOutcome('/repo-root', 'new-work', 7447, null, null, {
      currentHeadOid: 'bbbb2222bbbb2222'
    })

    expect(outcome).toMatchObject({ kind: 'found', pr: { number: 7447, state: 'merged' } })
    expect(outcome.kind === 'found' ? outcome.pr.headDivergedFromMergedPRAtOid : undefined).toBe(
      undefined
    )
  })

  it('leaves linked merged divergence unset when the membership probe returns a non-array payload', async () => {
    mockMergedLinkedPRLookup()
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ message: 'Server Error' })
    })

    const outcome = await getPRForBranchOutcome('/repo-root', 'new-work', 7447, null, null, {
      currentHeadOid: 'bbbb2222bbbb2222'
    })

    expect(outcome).toMatchObject({ kind: 'found', pr: { number: 7447, state: 'merged' } })
    expect(outcome.kind === 'found' ? outcome.pr.headDivergedFromMergedPRAtOid : undefined).toBe(
      undefined
    )
  })

  it('leaves linked merged divergence unset without a current head oid', async () => {
    mockMergedLinkedPRLookup()

    const outcome = await getPRForBranchOutcome('/repo-root', 'new-work', 7447, null, null)

    expect(outcome).toMatchObject({ kind: 'found', pr: { number: 7447, state: 'merged' } })
    expect(outcome.kind === 'found' ? outcome.pr.headDivergedFromMergedPRAtOid : undefined).toBe(
      undefined
    )
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('prefers branch lookup over a fallback PR number', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 43,
            title: 'Branch PR wins',
            state: 'open',
            html_url: 'https://github.com/acme/widgets/pull/43',
            updated_at: '2026-03-28T00:00:00Z',
            draft: false,
            mergeable: true,
            head: { ref: 'feature/test', sha: 'branch-head-oid' },
            base: { ref: 'main', sha: 'branch-base-oid' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 43,
          title: 'Hydrated branch PR wins',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/pull/43',
          statusCheckRollup: [],
          updatedAt: '2026-03-28T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'feature/test',
          baseRefOid: 'branch-base-oid',
          headRefOid: 'branch-head-oid'
        })
      })

    const pr = await getPRForBranch('/repo-root', 'feature/test', null, null, 42)

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      ['api', 'repos/acme/widgets/pulls?head=acme%3Afeature%2Ftest&state=all&per_page=1'],
      { cwd: '/repo-root' }
    )
    expect(pr).toMatchObject({ number: 43, title: 'Hydrated branch PR wins' })
  })

  it('uses a fallback PR number only after branch lookup misses', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 42,
          title: 'Fallback PR lookup',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/pull/42',
          statusCheckRollup: [],
          updatedAt: '2026-03-28T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'contributor/original',
          baseRefOid: 'base-oid',
          headRefOid: 'fallback-head-oid'
        })
      })

    const pr = await getPRForBranch('/repo-root', 'feature/test', null, null, 42)

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      ['api', 'repos/acme/widgets/pulls?head=acme%3Afeature%2Ftest&state=all&per_page=1'],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      [
        'pr',
        'view',
        '42',
        '--repo',
        'acme/widgets',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid'
      ],
      { cwd: '/repo-root' }
    )
    expect(pr).toMatchObject({ number: 42, title: 'Fallback PR lookup' })
  })

  it('reports upstream error when fallback branch discovery fails transiently then retry misses', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [{ owner: 'stablyai', repo: 'orca' }],
      headRepo: null
    })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('HTTP 429: API rate limit exceeded'))
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })

    const outcome = await getPRForBranchOutcome('/repo-root', 'feature/test')

    expect(outcome).toMatchObject({
      kind: 'upstream-error',
      errorType: 'rate_limited'
    })
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      [
        'pr',
        'list',
        '--repo',
        'stablyai/orca',
        '--head',
        'feature/test',
        '--state',
        'all',
        '--limit',
        '1',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,baseRefName,headRefName,baseRefOid,headRefOid'
      ],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['api', 'repos/stablyai/orca/pulls?head=stablyai%3Afeature%2Ftest&state=all&per_page=1'],
      { cwd: '/repo-root' }
    )
  })

  it('propagates a Retry-After cooldown into the rate-limited retry schedule', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [{ owner: 'stablyai', repo: 'orca' }],
      headRepo: null
    })
    // gh puts the diagnostic on `.stderr`; a secondary limit carries Retry-After.
    ghExecFileAsyncMock
      .mockRejectedValueOnce(
        Object.assign(new Error('gh exited with 1.'), {
          stderr: 'HTTP 403: You have exceeded a secondary rate limit\nRetry-After: 120'
        })
      )
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })

    const before = Date.now()
    const outcome = await getPRForBranchOutcome('/repo-root', 'feature/test')
    expect(outcome.kind).toBe('upstream-error')
    if (outcome.kind !== 'upstream-error') {
      throw new Error('expected upstream-error')
    }
    expect(outcome.errorType).toBe('rate_limited')
    // ~120s cooldown surfaced as both the manual gate and the auto-retry time.
    expect(outcome.retryDisabledUntil).toBeDefined()
    expect(outcome.nextAutoRetryAt).toBe(outcome.retryDisabledUntil)
    expect(outcome.retryDisabledUntil ?? 0).toBeGreaterThanOrEqual(before + 119_000)
    expect(outcome.retryDisabledUntil ?? 0).toBeLessThanOrEqual(Date.now() + 121_000)
  })

  it('reports no PR when fallback branch discovery cleanly misses', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [{ owner: 'stablyai', repo: 'orca' }],
      headRepo: null
    })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: JSON.stringify([]) })

    const outcome = await getPRForBranchOutcome('/repo-root', 'feature/test')

    expect(outcome.kind).toBe('no-pr')
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('returns found when fallback branch discovery retry finds the PR', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [{ owner: 'stablyai', repo: 'orca' }],
      headRepo: null
    })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('HTTP 429: API rate limit exceeded'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 42,
            title: 'Retry branch PR',
            state: 'open',
            html_url: 'https://github.com/stablyai/orca/pull/42',
            updated_at: '2026-03-28T00:00:00Z',
            draft: false,
            mergeable: true,
            base: { ref: 'main', sha: 'base-oid' },
            head: { ref: 'feature/test', sha: 'retry-head-oid' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 42,
          title: 'Hydrated retry branch PR',
          state: 'OPEN',
          url: 'https://github.com/stablyai/orca/pull/42',
          statusCheckRollup: [],
          updatedAt: '2026-03-28T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'feature/test',
          baseRefOid: 'base-oid',
          headRefOid: 'retry-head-oid'
        })
      })

    const outcome = await getPRForBranchOutcome('/repo-root', 'feature/test')

    expect(outcome).toMatchObject({
      kind: 'found',
      pr: {
        number: 42,
        title: 'Hydrated retry branch PR',
        prRepo: { owner: 'stablyai', repo: 'orca' }
      }
    })
  })

  it('lets fallback PR number recovery win after fallback branch queries throw', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [{ owner: 'stablyai', repo: 'orca' }],
      headRepo: null
    })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('HTTP 429: API rate limit exceeded'))
      .mockRejectedValueOnce(new Error('HTTP 502: Bad Gateway'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 42,
          title: 'Fallback number recovered PR',
          state: 'OPEN',
          url: 'https://github.com/stablyai/orca/pull/42',
          statusCheckRollup: [],
          updatedAt: '2026-03-28T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'feature/test',
          baseRefOid: 'base-oid',
          headRefOid: 'fallback-head-oid'
        })
      })

    const outcome = await getPRForBranchOutcome('/repo-root', 'feature/test', null, null, 42)

    expect(outcome).toMatchObject({
      kind: 'found',
      pr: {
        number: 42,
        title: 'Fallback number recovered PR'
      }
    })
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      [
        'pr',
        'view',
        '42',
        '--repo',
        'stablyai/orca',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid'
      ],
      { cwd: '/repo-root' }
    )
  })

  it('reports upstream error when fallback branch discovery has a network failure', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [{ owner: 'stablyai', repo: 'orca' }],
      headRepo: null
    })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('could not resolve host: api.github.com'))
      .mockRejectedValueOnce(new Error('could not resolve host: api.github.com'))

    const outcome = await getPRForBranchOutcome('/repo-root', 'feature/test')

    expect(outcome).toMatchObject({
      kind: 'upstream-error',
      errorType: 'network'
    })
  })

  it('reports a GitHub server error when fallback branch discovery receives 5xx responses', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [{ owner: 'stablyai', repo: 'orca' }],
      headRepo: null
    })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('HTTP 503: Service Unavailable'))
      .mockRejectedValueOnce(new Error('HTTP 502: Bad Gateway'))

    const outcome = await getPRForBranchOutcome('/repo-root', 'feature/test')

    expect(outcome).toMatchObject({
      kind: 'upstream-error',
      errorType: 'server_error'
    })
  })

  it('keeps a pending fallback branch error when a later candidate cleanly misses', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [
        { owner: 'stablyai', repo: 'orca' },
        { owner: 'fork', repo: 'orca' }
      ],
      headRepo: null
    })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('HTTP 429: API rate limit exceeded'))
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })

    const outcome = await getPRForBranchOutcome('/repo-root', 'feature/test')

    expect(outcome).toMatchObject({
      kind: 'upstream-error',
      errorType: 'rate_limited'
    })
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      [
        'pr',
        'list',
        '--repo',
        'fork/orca',
        '--head',
        'feature/test',
        '--state',
        'all',
        '--limit',
        '1',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,baseRefName,headRefName,baseRefOid,headRefOid'
      ],
      { cwd: '/repo-root' }
    )
  })

  it('treats a merged branch lookup as a miss before using a fallback PR number', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 5511,
            title: 'Merged branch PR',
            state: 'closed',
            merged_at: '2026-06-16T17:15:33Z',
            html_url: 'https://github.com/stablyai/orca/pull/5511',
            updated_at: '2026-06-16T17:15:33Z',
            draft: false,
            mergeable_state: 'clean',
            head: { ref: 'feature/test', sha: 'merged-head-oid' },
            base: { ref: 'main', sha: 'base-oid' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 5511,
          title: 'Merged branch PR',
          state: 'MERGED',
          url: 'https://github.com/stablyai/orca/pull/5511',
          statusCheckRollup: [],
          updatedAt: '2026-06-16T17:15:33Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'feature/test',
          baseRefOid: 'base-oid',
          headRefOid: 'merged-head-oid'
        })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 42,
          title: 'Open fallback PR',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/pull/42',
          statusCheckRollup: [],
          updatedAt: '2026-06-17T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'contributor/original',
          baseRefOid: 'base-oid',
          headRefOid: 'fallback-head-oid'
        })
      })

    const pr = await getPRForBranch('/repo-root', 'feature/test', null, null, 42)

    expect(pr).toMatchObject({ number: 42, title: 'Open fallback PR' })
  })

  it('returns a merged PR when branch lookup and fallback point at the same PR', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 5511,
            title: 'Merged current PR',
            state: 'closed',
            merged_at: '2026-06-16T17:15:33Z',
            html_url: 'https://github.com/acme/widgets/pull/5511',
            updated_at: '2026-06-16T17:15:33Z',
            draft: false,
            mergeable_state: 'clean',
            head: { ref: 'feature/test', sha: 'merged-head-oid' },
            base: { ref: 'main', sha: 'base-oid' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 5511,
          title: 'Merged current PR',
          state: 'MERGED',
          url: 'https://github.com/acme/widgets/pull/5511',
          statusCheckRollup: [],
          updatedAt: '2026-06-16T17:15:33Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'feature/test',
          baseRefOid: 'base-oid',
          headRefOid: 'merged-head-oid'
        })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 5511,
          title: 'Merged current PR',
          state: 'MERGED',
          url: 'https://github.com/acme/widgets/pull/5511',
          statusCheckRollup: [],
          updatedAt: '2026-06-16T17:15:33Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'feature/test',
          baseRefOid: 'base-oid',
          headRefOid: 'merged-head-oid'
        })
      })

    const pr = await getPRForBranch('/repo-root', 'feature/test', null, null, 5511)

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      [
        'pr',
        'view',
        '5511',
        '--repo',
        'acme/widgets',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid'
      ],
      { cwd: '/repo-root' }
    )
    expect(pr).toMatchObject({ number: 5511, state: 'merged', title: 'Merged current PR' })
  })

  it('does not carry a merged upstream branch head repo into a fallback PR number', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [{ owner: 'stablyai', repo: 'orca' }],
      headRepo: { owner: 'origin-owner', repo: 'orca' }
    })
    getOwnerRepoForRemoteMock.mockResolvedValueOnce({ owner: 'fork-owner', repo: 'orca' })
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'local-created-from-pr\0fork/contributor/original\n',
      stderr: ''
    })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 5511,
            title: 'Merged upstream branch PR',
            state: 'closed',
            merged_at: '2026-06-16T17:15:33Z',
            html_url: 'https://github.com/stablyai/orca/pull/5511',
            updated_at: '2026-06-16T17:15:33Z',
            draft: false,
            mergeable_state: 'clean',
            head: { ref: 'contributor/original', sha: 'merged-head-oid' },
            base: { ref: 'main', sha: 'base-oid' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 5511,
          title: 'Merged upstream branch PR',
          state: 'MERGED',
          url: 'https://github.com/stablyai/orca/pull/5511',
          statusCheckRollup: [],
          updatedAt: '2026-06-16T17:15:33Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'contributor/original',
          baseRefOid: 'base-oid',
          headRefOid: 'merged-head-oid'
        })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 42,
          title: 'Open fallback PR',
          state: 'OPEN',
          url: 'https://github.com/stablyai/orca/pull/42',
          statusCheckRollup: [],
          updatedAt: '2026-06-17T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'fresh/fallback',
          baseRefOid: 'base-oid',
          headRefOid: 'fallback-head-oid'
        })
      })

    const pr = await getPRForBranch('/repo-root', 'local-created-from-pr', null, null, 42)

    expect(pr).toMatchObject({
      number: 42,
      title: 'Open fallback PR',
      headRepo: { owner: 'origin-owner', repo: 'orca' }
    })
  })

  it('ignores merged PRs discovered only from a fallback PR number', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 5511,
          title: 'Merged fallback PR',
          state: 'MERGED',
          url: 'https://github.com/stablyai/orca/pull/5511',
          statusCheckRollup: [],
          updatedAt: '2026-06-16T17:15:33Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'add-guide-for-mobile-emulator-use',
          baseRefOid: 'base-oid',
          headRefOid: 'head-oid'
        })
      })

    const pr = await getPRForBranch(
      '/repo-root',
      'add-guide-for-mobile-emulator-use',
      null,
      null,
      5511
    )

    expect(pr).toBeNull()
  })

  it('returns a merged fallback PR when visible fallback lifecycle is accepted', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 5511,
          title: 'Merged visible fallback PR',
          state: 'MERGED',
          url: 'https://github.com/acme/widgets/pull/5511',
          statusCheckRollup: [],
          updatedAt: '2026-06-16T17:15:33Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'deleted-head',
          baseRefOid: 'base-oid',
          headRefOid: 'head-oid'
        })
      })

    const pr = await getPRForBranch('/repo-root', 'deleted-head', null, null, 5511, {
      acceptMergedFallbackPR: true
    })

    expect(pr).toMatchObject({
      number: 5511,
      state: 'merged',
      title: 'Merged visible fallback PR'
    })
  })

  it('falls back to the tracked upstream branch when the local branch name differs', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 78,
            title: 'Upstream branch PR',
            state: 'open',
            html_url: 'https://github.com/acme/widgets/pull/78',
            updated_at: '2026-03-28T00:00:00Z',
            draft: false,
            mergeable: true,
            base: { ref: 'main', sha: 'base-oid' },
            head: { ref: 'contributor/original', sha: 'upstream-head-oid' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 78,
          title: 'Hydrated upstream branch PR',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/pull/78',
          statusCheckRollup: [],
          updatedAt: '2026-03-28T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'contributor/original',
          baseRefOid: 'base-oid',
          headRefOid: 'upstream-head-oid'
        })
      })
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'local-created-from-pr\0origin/contributor/original\n',
      stderr: ''
    })

    const pr = await getPRForBranch('/repo-root', 'local-created-from-pr')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['for-each-ref', '--format=%(refname)%00%(upstream)', 'refs/heads'],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      ['api', 'repos/acme/widgets/pulls?head=acme%3Alocal-created-from-pr&state=all&per_page=1'],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['api', 'repos/acme/widgets/pulls?head=acme%3Acontributor%2Foriginal&state=all&per_page=1'],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      [
        'pr',
        'view',
        '78',
        '--repo',
        'acme/widgets',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid'
      ],
      { cwd: '/repo-root' }
    )
    expect(pr).toMatchObject({
      number: 78,
      title: 'Hydrated upstream branch PR',
      headSha: 'upstream-head-oid'
    })
  })

  it('does not repeat missing tracked-upstream probes during PR refresh polling', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValue({
      candidates: [{ owner: 'acme', repo: 'widgets' }],
      headRepo: { owner: 'acme', repo: 'widgets' }
    })
    ghExecFileAsyncMock.mockResolvedValue({ stdout: JSON.stringify([]) })
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'no-pr-branch\0\n', stderr: '' })

    await getPRForBranch('/repo-root', 'no-pr-branch')
    await getPRForBranch('/repo-root', 'no-pr-branch')
    await getPRForBranch('/repo-root', 'no-pr-branch')

    const trackedUpstreamCalls = gitExecFileAsyncMock.mock.calls.filter(([args]) =>
      (args as string[]).includes('refs/heads')
    )
    expect(trackedUpstreamCalls).toHaveLength(1)
  })

  it('releases tracked-upstream probe generations across runtime identities', async () => {
    const sshGitProvider = {
      exec: vi.fn().mockResolvedValue({ stdout: 'feature\0\n', stderr: '' })
    }
    getSshGitProviderMock.mockReturnValue(sshGitProvider)
    getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValue({ stdout: JSON.stringify([]) })
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'feature\0\n', stderr: '' })

    await getPRForBranch('/repo-root', 'feature')
    await getPRForBranch('/repo-root', 'feature', null, null, null, {
      localGitExecOptions: { wslDistro: 'Ubuntu' }
    })
    await getPRForBranch('/repo-root', 'feature', null, 'ssh-1')

    expect(_getTrackedUpstreamBranchCacheSizesForTests()).toEqual({
      snapshots: 3,
      inFlight: 0,
      generations: 0
    })
    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(sshGitProvider.exec).toHaveBeenCalledTimes(1)
  })

  it('bounds unique tracked-upstream snapshots and sweeps expired identities', async () => {
    vi.useFakeTimers()
    try {
      getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
      ghExecFileAsyncMock.mockResolvedValue({ stdout: JSON.stringify([]) })
      gitExecFileAsyncMock.mockResolvedValue({ stdout: 'feature\0\n', stderr: '' })

      for (let index = 0; index < 513; index += 1) {
        await getPRForBranch(`/repo-root-${index}`, 'feature')
      }
      await getPRForBranch('/repo-root-512', 'feature')

      expect(_getTrackedUpstreamBranchCacheSizesForTests()).toEqual({
        snapshots: 512,
        inFlight: 0,
        generations: 0
      })
      expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(513)

      await vi.advanceTimersByTimeAsync(30_001)
      await getPRForBranch('/repo-root-fresh', 'feature')

      expect(_getTrackedUpstreamBranchCacheSizesForTests()).toEqual({
        snapshots: 1,
        inFlight: 0,
        generations: 0
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps stale probe cleanup from releasing a replacement generation', async () => {
    let resolveOldProbe: (value: { stdout: string; stderr: string }) => void
    let resolveCurrentProbe: (value: { stdout: string; stderr: string }) => void
    getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValue({ stdout: JSON.stringify([]) })
    gitExecFileAsyncMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOldProbe = resolve
          })
      )
      .mockResolvedValueOnce({ stdout: 'replacement\0\n', stderr: '' })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveCurrentProbe = resolve
          })
      )

    const oldLookup = getPRForBranch('/repo-root', 'old')
    await vi.waitFor(() => expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1))
    __resetTrackedUpstreamBranchCacheForTests()
    await getPRForBranch('/repo-root', 'replacement')
    const currentLookup = getPRForBranch('/repo-root', 'current')
    await vi.waitFor(() => expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(3))

    resolveOldProbe!({ stdout: 'old\0\n', stderr: '' })
    await oldLookup
    expect(_getTrackedUpstreamBranchCacheSizesForTests()).toEqual({
      snapshots: 0,
      inFlight: 1,
      generations: 1
    })

    resolveCurrentProbe!({ stdout: 'current\0\n', stderr: '' })
    await currentLookup
    expect(_getTrackedUpstreamBranchCacheSizesForTests()).toEqual({
      snapshots: 1,
      inFlight: 0,
      generations: 0
    })
  })

  it('releases tracked-upstream probe state when setup rejects', async () => {
    getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValue({ stdout: JSON.stringify([]) })
    readLocalGitConfigSignatureMock.mockRejectedValue(new Error('git config unavailable'))

    await expect(getPRForBranch('/repo-root', 'feature')).resolves.toBeNull()
    expect(_getTrackedUpstreamBranchCacheSizesForTests()).toEqual({
      snapshots: 0,
      inFlight: 0,
      generations: 0
    })
  })

  it('does not fan out tracked-upstream probes after a transient for-each-ref failure', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValue({
      candidates: [{ owner: 'acme', repo: 'widgets' }],
      headRepo: { owner: 'acme', repo: 'widgets' }
    })
    ghExecFileAsyncMock.mockResolvedValue({ stdout: JSON.stringify([]) })
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('fatal: cannot lock ref'))
      .mockResolvedValue({ stdout: 'alpha\0\nbeta\0\ngamma\0\n', stderr: '' })

    await getPRForBranch('/repo-root', 'alpha')
    await getPRForBranch('/repo-root', 'beta')
    await getPRForBranch('/repo-root', 'gamma')

    const trackedUpstreamCalls = gitExecFileAsyncMock.mock.calls.filter(([args]) =>
      (args as string[]).includes('refs/heads')
    )
    expect(trackedUpstreamCalls).toHaveLength(2)
  })

  it('refreshes the tracked-upstream snapshot when a branch appears inside the TTL', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValue({
      candidates: [{ owner: 'acme', repo: 'widgets' }],
      headRepo: { owner: 'acme', repo: 'widgets' }
    })
    getOwnerRepoForRemoteMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'existing\0\n', stderr: '' })
      .mockResolvedValueOnce({
        stdout: 'existing\0\nnew-feature\0origin/contributor/original\n',
        stderr: ''
      })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 78,
            title: 'New branch upstream PR',
            state: 'open',
            html_url: 'https://github.com/acme/widgets/pull/78',
            updated_at: '2026-03-28T00:00:00Z',
            draft: false,
            mergeable: true,
            base: { ref: 'main', sha: 'base-oid' },
            head: { ref: 'contributor/original', sha: 'upstream-head-oid' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 78,
          title: 'Hydrated new branch upstream PR',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/pull/78',
          statusCheckRollup: [],
          updatedAt: '2026-03-28T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'contributor/original',
          baseRefOid: 'base-oid',
          headRefOid: 'upstream-head-oid'
        })
      })

    await getPRForBranch('/repo-root', 'existing')
    const pr = await getPRForBranch('/repo-root', 'new-feature')

    const trackedUpstreamCalls = gitExecFileAsyncMock.mock.calls.filter(([args]) =>
      (args as string[]).includes('refs/heads')
    )
    expect(trackedUpstreamCalls).toHaveLength(2)
    expect(pr).toMatchObject({
      number: 78,
      title: 'Hydrated new branch upstream PR'
    })
  })

  it('parses full local branch refs from the tracked-upstream snapshot', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'refs/heads/feature\0origin/contributor/original\n',
      stderr: ''
    })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 80,
            title: 'Ambiguous ref upstream PR',
            state: 'open',
            html_url: 'https://github.com/acme/widgets/pull/80',
            updated_at: '2026-03-28T00:00:00Z',
            draft: false,
            mergeable: true,
            base: { ref: 'main', sha: 'base-oid' },
            head: { ref: 'contributor/original', sha: 'upstream-head-oid' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 80,
          title: 'Hydrated ambiguous ref upstream PR',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/pull/80',
          statusCheckRollup: [],
          updatedAt: '2026-03-28T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'contributor/original',
          baseRefOid: 'base-oid',
          headRefOid: 'upstream-head-oid'
        })
      })

    const pr = await getPRForBranch('/repo-root', 'feature')

    expect(pr).toMatchObject({
      number: 80,
      title: 'Hydrated ambiguous ref upstream PR'
    })
  })

  it('parses full upstream refs from the tracked-upstream snapshot', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    getOwnerRepoForRemoteMock.mockResolvedValueOnce({ owner: 'fork-owner', repo: 'widgets' })
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'refs/heads/feature\0refs/remotes/fork/contributor/original\n',
      stderr: ''
    })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 83,
            title: 'Full upstream ref PR',
            state: 'open',
            html_url: 'https://github.com/acme/widgets/pull/83',
            updated_at: '2026-03-28T00:00:00Z',
            draft: false,
            mergeable: true,
            base: { ref: 'main', sha: 'base-oid' },
            head: { ref: 'contributor/original', sha: 'upstream-head-oid' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 83,
          title: 'Hydrated full upstream ref PR',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/pull/83',
          statusCheckRollup: [],
          updatedAt: '2026-03-28T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'contributor/original',
          baseRefOid: 'base-oid',
          headRefOid: 'upstream-head-oid'
        })
      })

    const pr = await getPRForBranch('/repo-root', 'feature')

    expect(getOwnerRepoForRemoteMock).toHaveBeenCalledWith('/repo-root', 'fork', undefined)
    expect(pr).toMatchObject({
      number: 83,
      title: 'Hydrated full upstream ref PR',
      headRepo: { owner: 'fork-owner', repo: 'widgets' }
    })
  })

  it('ignores full local-branch upstream refs from the tracked-upstream snapshot', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'refs/heads/feature\0refs/heads/main\n',
      stderr: ''
    })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: JSON.stringify([]) })

    const pr = await getPRForBranch('/repo-root', 'feature')

    expect(pr).toBeNull()
    expect(getOwnerRepoForRemoteMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('invalidates the local tracked-upstream snapshot when git config changes', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValue({
      candidates: [{ owner: 'acme', repo: 'widgets' }],
      headRepo: { owner: 'acme', repo: 'widgets' }
    })
    getOwnerRepoForRemoteMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    readLocalGitConfigSignatureMock
      .mockResolvedValueOnce('/repo-root/.git/config\u0000mtime-a\u0000100')
      .mockResolvedValueOnce('/repo-root/.git/config\u0000mtime-a\u0000100')
      .mockResolvedValueOnce('/repo-root/.git/config\u0000mtime-b\u0000120')
      .mockResolvedValueOnce('/repo-root/.git/config\u0000mtime-b\u0000120')
      .mockResolvedValueOnce('/repo-root/.git/config\u0000mtime-b\u0000120')
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature\0\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'feature\0origin/contributor/original\n', stderr: '' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 79,
            title: 'Reconfigured upstream PR',
            state: 'open',
            html_url: 'https://github.com/acme/widgets/pull/79',
            updated_at: '2026-03-28T00:00:00Z',
            draft: false,
            mergeable: true,
            base: { ref: 'main', sha: 'base-oid' },
            head: { ref: 'contributor/original', sha: 'upstream-head-oid' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 79,
          title: 'Hydrated reconfigured upstream PR',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/pull/79',
          statusCheckRollup: [],
          updatedAt: '2026-03-28T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'contributor/original',
          baseRefOid: 'base-oid',
          headRefOid: 'upstream-head-oid'
        })
      })

    await getPRForBranch('/repo-root', 'feature')
    const pr = await getPRForBranch('/repo-root', 'feature')

    const trackedUpstreamCalls = gitExecFileAsyncMock.mock.calls.filter(([args]) =>
      (args as string[]).includes('refs/heads')
    )
    expect(trackedUpstreamCalls).toHaveLength(2)
    expect(pr).toMatchObject({
      number: 79,
      title: 'Hydrated reconfigured upstream PR'
    })
  })

  it('does not cache positive tracked-upstream entries when config changes during the snapshot', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValue({
      candidates: [{ owner: 'acme', repo: 'widgets' }],
      headRepo: { owner: 'acme', repo: 'widgets' }
    })
    getOwnerRepoForRemoteMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    readLocalGitConfigSignatureMock
      .mockResolvedValueOnce('/repo-root/.git/config\u0000mtime-a\u0000100')
      .mockResolvedValueOnce('/repo-root/.git/config\u0000mtime-b\u0000120')
      .mockResolvedValueOnce('/repo-root/.git/config\u0000mtime-b\u0000120')
      .mockResolvedValueOnce('/repo-root/.git/config\u0000mtime-b\u0000120')
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature\0origin/old-upstream\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'feature\0origin/contributor/original\n', stderr: '' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 82,
            title: 'Stable config upstream PR',
            state: 'open',
            html_url: 'https://github.com/acme/widgets/pull/82',
            updated_at: '2026-03-28T00:00:00Z',
            draft: false,
            mergeable: true,
            base: { ref: 'main', sha: 'base-oid' },
            head: { ref: 'contributor/original', sha: 'upstream-head-oid' }
          }
        ])
      })

    await getPRForBranch('/repo-root', 'feature')
    const pr = await getPRForBranch('/repo-root', 'feature')

    const trackedUpstreamCalls = gitExecFileAsyncMock.mock.calls.filter(([args]) =>
      (args as string[]).includes('refs/heads')
    )
    expect(trackedUpstreamCalls).toHaveLength(2)
    expect(pr).toMatchObject({
      number: 82,
      title: 'Stable config upstream PR'
    })
  })

  it('does not cache null tracked-upstream entries when config changes during the snapshot', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValue({
      candidates: [{ owner: 'acme', repo: 'widgets' }],
      headRepo: { owner: 'acme', repo: 'widgets' }
    })
    getOwnerRepoForRemoteMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    readLocalGitConfigSignatureMock
      .mockResolvedValueOnce('/repo-root/.git/config\u0000mtime-a\u0000100')
      .mockResolvedValueOnce('/repo-root/.git/config\u0000mtime-b\u0000120')
      .mockResolvedValueOnce('/repo-root/.git/config\u0000mtime-b\u0000120')
      .mockResolvedValueOnce('/repo-root/.git/config\u0000mtime-b\u0000120')
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'feature\0\n', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'feature\0origin/contributor/original\n', stderr: '' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 85,
            title: 'Unstable config upstream PR',
            state: 'open',
            html_url: 'https://github.com/acme/widgets/pull/85',
            updated_at: '2026-03-28T00:00:00Z',
            draft: false,
            mergeable: true,
            base: { ref: 'main', sha: 'base-oid' },
            head: { ref: 'contributor/original', sha: 'upstream-head-oid' }
          }
        ])
      })

    await getPRForBranch('/repo-root', 'feature')
    const pr = await getPRForBranch('/repo-root', 'feature')

    const trackedUpstreamCalls = gitExecFileAsyncMock.mock.calls.filter(([args]) =>
      (args as string[]).includes('refs/heads')
    )
    expect(trackedUpstreamCalls).toHaveLength(2)
    expect(pr).toMatchObject({
      number: 85,
      title: 'Unstable config upstream PR'
    })
  })

  it('coalesces concurrent missing tracked-upstream probes', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValue({
      candidates: [{ owner: 'acme', repo: 'widgets' }],
      headRepo: { owner: 'acme', repo: 'widgets' }
    })
    ghExecFileAsyncMock.mockResolvedValue({ stdout: JSON.stringify([]) })
    gitExecFileAsyncMock.mockImplementation(async () => {
      await Promise.resolve()
      return { stdout: 'no-pr-branch\0\n', stderr: '' }
    })

    await Promise.all([
      getPRForBranch('/repo-root', 'no-pr-branch'),
      getPRForBranch('/repo-root', 'no-pr-branch'),
      getPRForBranch('/repo-root', 'no-pr-branch')
    ])

    const trackedUpstreamCalls = gitExecFileAsyncMock.mock.calls.filter(([args]) =>
      (args as string[]).includes('refs/heads')
    )
    expect(trackedUpstreamCalls).toHaveLength(1)
  })

  it('does not cache synthetic nulls from concurrent tracked-upstream waiters', async () => {
    let resolveSnapshot: (value: { stdout: string; stderr: string }) => void
    resolvePRRepositoryCandidatesMock.mockResolvedValue({
      candidates: [{ owner: 'acme', repo: 'widgets' }],
      headRepo: { owner: 'acme', repo: 'widgets' }
    })
    getOwnerRepoForRemoteMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    readLocalGitConfigSignatureMock.mockResolvedValue(
      '/repo-root/.git/config\u0000mtime-a\u0000100'
    )
    gitExecFileAsyncMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSnapshot = resolve
          })
      )
      .mockResolvedValueOnce({ stdout: 'new-feature\0origin/contributor/original\n', stderr: '' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 84,
            title: 'Concurrent waiter upstream PR',
            state: 'open',
            html_url: 'https://github.com/acme/widgets/pull/84',
            updated_at: '2026-03-28T00:00:00Z',
            draft: false,
            mergeable: true,
            base: { ref: 'main', sha: 'base-oid' },
            head: { ref: 'contributor/original', sha: 'upstream-head-oid' }
          }
        ])
      })

    const existingLookup = getPRForBranch('/repo-root', 'existing')
    const waiterLookup = getPRForBranch('/repo-root', 'new-feature')
    await vi.waitFor(() => expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(1))
    resolveSnapshot!({ stdout: 'existing\0\n', stderr: '' })
    const [, waiterPr] = await Promise.all([existingLookup, waiterLookup])

    const trackedUpstreamCalls = gitExecFileAsyncMock.mock.calls.filter(([args]) =>
      (args as string[]).includes('refs/heads')
    )
    expect(trackedUpstreamCalls).toHaveLength(2)
    expect(waiterPr).toMatchObject({
      number: 84,
      title: 'Concurrent waiter upstream PR'
    })
  })

  it('keeps missing tracked-upstream probes separate for host and WSL runtimes', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValue({
      candidates: [{ owner: 'acme', repo: 'widgets' }],
      headRepo: { owner: 'acme', repo: 'widgets' }
    })
    ghExecFileAsyncMock.mockResolvedValue({ stdout: JSON.stringify([]) })
    gitExecFileAsyncMock.mockResolvedValue({ stdout: 'no-pr-branch\0\n', stderr: '' })

    await getPRForBranch('/repo-root', 'no-pr-branch')
    await getPRForBranch('/repo-root', 'no-pr-branch', null, null, null, {
      localGitExecOptions: { wslDistro: 'Ubuntu' }
    })
    await getPRForBranch('/repo-root', 'no-pr-branch')
    await getPRForBranch('/repo-root', 'no-pr-branch', null, null, null, {
      localGitExecOptions: { wslDistro: 'Ubuntu' }
    })

    const trackedUpstreamCalls = gitExecFileAsyncMock.mock.calls.filter(([args]) =>
      (args as string[]).includes('refs/heads')
    )
    expect(trackedUpstreamCalls).toHaveLength(2)
    expect(trackedUpstreamCalls[0][1]).toEqual({ cwd: '/repo-root' })
    expect(trackedUpstreamCalls[1][1]).toEqual({
      cwd: '/repo-root',
      wslDistro: 'Ubuntu'
    })
  })

  it('rechecks missing tracked-upstream probes after the null-cache TTL expires', async () => {
    vi.useFakeTimers()
    try {
      resolvePRRepositoryCandidatesMock.mockResolvedValue({
        candidates: [{ owner: 'acme', repo: 'widgets' }],
        headRepo: { owner: 'acme', repo: 'widgets' }
      })
      ghExecFileAsyncMock.mockResolvedValue({ stdout: JSON.stringify([]) })
      gitExecFileAsyncMock
        .mockRejectedValueOnce(new Error("fatal: no upstream configured for branch 'feature'"))
        .mockResolvedValueOnce({ stdout: 'feature\0origin/contributor/original\n', stderr: '' })

      await getPRForBranch('/repo-root', 'feature')
      await vi.advanceTimersByTimeAsync(30_001)
      await getPRForBranch('/repo-root', 'feature')

      const trackedUpstreamCalls = gitExecFileAsyncMock.mock.calls.filter(([args]) =>
        (args as string[]).includes('refs/heads')
      )
      expect(trackedUpstreamCalls).toHaveLength(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses the tracked upstream remote owner for fork branch lookup', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [
        { owner: 'stablyai', repo: 'orca' },
        { owner: 'origin-owner', repo: 'orca' }
      ],
      headRepo: { owner: 'origin-owner', repo: 'orca' }
    })
    getOwnerRepoForRemoteMock.mockResolvedValueOnce({ owner: 'fork-owner', repo: 'orca' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 78,
            title: 'Fork upstream branch PR',
            state: 'open',
            html_url: 'https://github.com/stablyai/orca/pull/78',
            updated_at: '2026-03-28T00:00:00Z',
            draft: false,
            mergeable: true,
            base: { ref: 'main', sha: 'base-oid' },
            head: { ref: 'contributor/original', sha: 'upstream-head-oid' }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 78,
          title: 'Hydrated fork upstream branch PR',
          state: 'OPEN',
          url: 'https://github.com/stablyai/orca/pull/78',
          statusCheckRollup: [],
          updatedAt: '2026-03-28T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'contributor/original',
          baseRefOid: 'base-oid',
          headRefOid: 'upstream-head-oid'
        })
      })
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'local-created-from-pr\0fork/contributor/original\n',
      stderr: ''
    })

    const pr = await getPRForBranch('/repo-root', 'local-created-from-pr')

    expect(getOwnerRepoForRemoteMock).toHaveBeenCalledWith('/repo-root', 'fork', undefined)
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      [
        'api',
        'repos/stablyai/orca/pulls?head=fork-owner%3Acontributor%2Foriginal&state=all&per_page=1'
      ],
      { cwd: '/repo-root' }
    )
    expect(pr).toMatchObject({
      number: 78,
      title: 'Hydrated fork upstream branch PR',
      prRepo: { owner: 'stablyai', repo: 'orca' },
      headRepo: { owner: 'fork-owner', repo: 'orca' }
    })
  })

  it('uses the tracked upstream remote owner when the fork branch name matches locally', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [
        { owner: 'stablyai', repo: 'orca' },
        { owner: 'origin-owner', repo: 'orca' }
      ],
      headRepo: { owner: 'origin-owner', repo: 'orca' }
    })
    getOwnerRepoForRemoteMock.mockResolvedValueOnce({ owner: 'brennanb2025', repo: 'orca' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 6433,
            title: 'Recover Windows worktree deletes from long paths',
            state: 'open',
            html_url: 'https://github.com/stablyai/orca/pull/6433',
            updated_at: '2026-06-26T00:00:00Z',
            draft: false,
            mergeable: true,
            base: { ref: 'main', sha: 'base-oid' },
            head: {
              ref: 'brennanb2025/worktree-remove-fix',
              sha: 'same-name-fork-head-oid'
            }
          }
        ])
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 6433,
          title: 'Recover Windows worktree deletes from long paths',
          state: 'OPEN',
          url: 'https://github.com/stablyai/orca/pull/6433',
          statusCheckRollup: [],
          updatedAt: '2026-06-26T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          headRefName: 'brennanb2025/worktree-remove-fix',
          baseRefOid: 'base-oid',
          headRefOid: 'same-name-fork-head-oid'
        })
      })
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'brennanb2025/worktree-remove-fix\0brennan/brennanb2025/worktree-remove-fix\n',
      stderr: ''
    })

    const pr = await getPRForBranch('/repo-root', 'brennanb2025/worktree-remove-fix')

    expect(getOwnerRepoForRemoteMock).toHaveBeenCalledWith('/repo-root', 'brennan', undefined)
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      [
        'api',
        'repos/stablyai/orca/pulls?head=brennanb2025%3Abrennanb2025%2Fworktree-remove-fix&state=all&per_page=1'
      ],
      { cwd: '/repo-root' }
    )
    expect(pr).toMatchObject({
      number: 6433,
      prRepo: { owner: 'stablyai', repo: 'orca' },
      headRepo: { owner: 'brennanb2025', repo: 'orca' }
    })
  })

  it('does not retry same-name tracked upstream lookup for the same head repo', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [{ owner: 'acme', repo: 'widgets' }],
      headRepo: { owner: 'acme', repo: 'widgets' }
    })
    getOwnerRepoForRemoteMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: JSON.stringify([]) })
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'feature/no-pr\0origin/feature/no-pr\n',
      stderr: ''
    })

    await expect(getPRForBranch('/repo-root', 'feature/no-pr')).resolves.toBeNull()

    expect(getOwnerRepoForRemoteMock).toHaveBeenCalledWith('/repo-root', 'origin', undefined)
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['api', 'repos/acme/widgets/pulls?head=acme%3Afeature%2Fno-pr&state=all&per_page=1'],
      { cwd: '/repo-root' }
    )
  })

  it('checks the tracked upstream branch through the SSH git provider', async () => {
    const sshGitProvider = {
      exec: vi.fn().mockResolvedValue({
        stdout: 'local-created-from-pr\0origin/contributor/original\n',
        stderr: ''
      })
    }
    getSshGitProviderMock.mockReturnValue(sshGitProvider)
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    getOwnerRepoForRemoteMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 78,
            title: 'SSH upstream branch PR',
            state: 'open',
            html_url: 'https://github.com/acme/widgets/pull/78',
            updated_at: '2026-03-28T00:00:00Z',
            draft: false,
            mergeable: true,
            base: { ref: 'main', sha: 'base-oid' },
            head: { ref: 'contributor/original', sha: 'upstream-head-oid' }
          }
        ])
      })

    const pr = await getPRForBranch(
      '/remote/repo-root',
      'local-created-from-pr',
      undefined,
      'ssh-1'
    )

    expect(sshGitProvider.exec).toHaveBeenCalledWith(
      ['for-each-ref', '--format=%(refname)%00%(upstream)', 'refs/heads'],
      '/remote/repo-root'
    )
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['api', 'repos/acme/widgets/pulls?head=acme%3Acontributor%2Foriginal&state=all&per_page=1'],
      {}
    )
    expect(pr).toMatchObject({ number: 78, title: 'SSH upstream branch PR' })
  })

  it('uses the same-name tracked upstream fork owner through the SSH git provider', async () => {
    const sshGitProvider = {
      exec: vi.fn().mockResolvedValue({
        stdout: 'contributor/fix\0fork/contributor/fix\n',
        stderr: ''
      })
    }
    getSshGitProviderMock.mockReturnValue(sshGitProvider)
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [
        { owner: 'stablyai', repo: 'orca' },
        { owner: 'origin-owner', repo: 'orca' }
      ],
      headRepo: { owner: 'origin-owner', repo: 'orca' }
    })
    getOwnerRepoForRemoteMock.mockResolvedValueOnce({ owner: 'fork-owner', repo: 'orca' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            number: 79,
            title: 'SSH same-name fork PR',
            state: 'open',
            html_url: 'https://github.com/stablyai/orca/pull/79',
            updated_at: '2026-03-28T00:00:00Z',
            draft: false,
            mergeable: true,
            base: { ref: 'main', sha: 'base-oid' },
            head: { ref: 'contributor/fix', sha: 'same-name-ssh-head-oid' }
          }
        ])
      })

    const pr = await getPRForBranch('/remote/repo-root', 'contributor/fix', undefined, 'ssh-1')

    expect(getOwnerRepoForRemoteMock).toHaveBeenCalledWith('/remote/repo-root', 'fork', 'ssh-1')
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      ['api', 'repos/stablyai/orca/pulls?head=fork-owner%3Acontributor%2Ffix&state=all&per_page=1'],
      {}
    )
    expect(pr).toMatchObject({
      number: 79,
      title: 'SSH same-name fork PR',
      prRepo: { owner: 'stablyai', repo: 'orca' },
      headRepo: { owner: 'fork-owner', repo: 'orca' }
    })
  })

  it('caches positive tracked-upstream entries for unsigned SSH runtimes during PR refresh polling', async () => {
    const sshGitProvider = {
      exec: vi.fn().mockResolvedValue({
        stdout: 'refs/heads/feature\0origin/contributor/original\n',
        stderr: ''
      })
    }
    getSshGitProviderMock.mockReturnValue(sshGitProvider)
    getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    getOwnerRepoForRemoteMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValue({ stdout: JSON.stringify([]) })

    await getPRForBranch('/remote/repo-root', 'feature', undefined, 'ssh-1')
    await getPRForBranch('/remote/repo-root', 'feature', undefined, 'ssh-1')
    await getPRForBranch('/remote/repo-root', 'feature', undefined, 'ssh-1')

    expect(sshGitProvider.exec).toHaveBeenCalledTimes(1)
  })

  it('refreshes positive tracked-upstream entries for unsigned SSH runtimes after the TTL', async () => {
    vi.useFakeTimers()
    try {
      const sshGitProvider = {
        exec: vi
          .fn()
          .mockResolvedValueOnce({
            stdout: 'refs/heads/feature\0origin/old-upstream\n',
            stderr: ''
          })
          .mockResolvedValueOnce({
            stdout: 'refs/heads/feature\0origin/contributor/original\n',
            stderr: ''
          })
      }
      getSshGitProviderMock.mockReturnValue(sshGitProvider)
      getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
      getOwnerRepoForRemoteMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
      ghExecFileAsyncMock
        .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
        .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
        .mockResolvedValueOnce({ stdout: JSON.stringify([]) })
        .mockResolvedValueOnce({
          stdout: JSON.stringify([
            {
              number: 81,
              title: 'Fresh SSH upstream PR',
              state: 'open',
              html_url: 'https://github.com/acme/widgets/pull/81',
              updated_at: '2026-03-28T00:00:00Z',
              draft: false,
              mergeable: true,
              base: { ref: 'main', sha: 'base-oid' },
              head: { ref: 'contributor/original', sha: 'upstream-head-oid' }
            }
          ])
        })

      await getPRForBranch('/remote/repo-root', 'feature', undefined, 'ssh-1')
      await vi.advanceTimersByTimeAsync(30_001)
      const pr = await getPRForBranch('/remote/repo-root', 'feature', undefined, 'ssh-1')

      expect(sshGitProvider.exec).toHaveBeenCalledTimes(2)
      expect(pr).toMatchObject({
        number: 81,
        title: 'Fresh SSH upstream PR'
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses linked PR number as the source of truth when provided', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 77,
        title: 'Linked PR lookup',
        state: 'OPEN',
        url: 'https://github.com/acme/widgets/pull/77',
        statusCheckRollup: [],
        updatedAt: '2026-03-28T00:00:00Z',
        isDraft: false,
        mergeable: 'MERGEABLE',
        baseRefName: 'main',
        headRefName: 'contributor/original',
        baseRefOid: 'base-oid',
        headRefOid: 'head-oid'
      })
    })

    const pr = await getPRForBranch('/repo-root', 'refs/heads/local-created-from-pr', 77)

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'pr',
        'view',
        '77',
        '--repo',
        'acme/widgets',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid'
      ],
      { cwd: '/repo-root' }
    )
    expect(pr?.number).toBe(77)
  })

  it('normalizes exact linked PR fallback metadata when no GitHub remote is resolved', async () => {
    getOwnerRepoMock.mockResolvedValueOnce(null)
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 77,
        title: 'Linked fallback PR',
        state: 'OPEN',
        url: 'https://example.com/pr/77',
        statusCheckRollup: [],
        updatedAt: '2026-03-28T00:00:00Z',
        isDraft: false,
        mergeable: 'MERGEABLE',
        reviewDecision: '',
        autoMergeRequest: { enabledAt: '2026-03-28T00:00:00Z' },
        baseRefName: 'main',
        headRefName: 'feature/test',
        baseRefOid: 'base-oid',
        headRefOid: 'head-oid'
      })
    })

    const pr = await getPRForBranch('/non-github-repo', 'feature/test', 77)

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'pr',
        'view',
        '77',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid'
      ],
      { cwd: '/non-github-repo' }
    )
    expect(pr).toMatchObject({
      number: 77,
      reviewDecision: null,
      autoMergeEnabled: true
    })
    expect(pr?.mergeQueueRequired).toBeUndefined()
  })

  it('falls back to gh pr view when the remote cannot be resolved to GitHub', async () => {
    getOwnerRepoMock.mockResolvedValueOnce(null)
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 7,
        title: 'Fallback lookup',
        state: 'OPEN',
        url: 'https://example.com/pr/7',
        statusCheckRollup: [],
        updatedAt: '2026-03-28T00:00:00Z',
        isDraft: true,
        mergeable: 'CONFLICTING',
        baseRefName: 'main',
        headRefName: 'feature/test',
        baseRefOid: 'base-oid',
        headRefOid: 'head-oid'
      })
    })

    const pr = await getPRForBranch('/non-github-repo', 'feature/test')

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'pr',
        'view',
        'feature/test',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid'
      ],
      { cwd: '/non-github-repo' }
    )
    expect(pr?.number).toBe(7)
    expect(pr?.state).toBe('draft')
    expect(pr?.mergeable).toBe('CONFLICTING')
  })

  it('derives a read-only conflict summary for conflicting PRs when the base ref exists locally', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 42,
          title: 'Fix PR discovery',
          state: 'open',
          html_url: 'https://github.com/acme/widgets/pull/42',
          updated_at: '2026-03-28T00:00:00Z',
          draft: false,
          mergeable_state: 'dirty',
          base: { ref: 'main', sha: 'base-oid' },
          head: { ref: 'feature/test', sha: 'head-oid' }
        }
      ])
    })
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: 'latest-base-oid\n' })
      .mockResolvedValueOnce({ stdout: 'merge-base-oid\n' })
      .mockResolvedValueOnce({ stdout: '3\n' })
      .mockResolvedValueOnce({ stdout: 'result-tree-oid\u0000src/a.ts\u0000src/b.ts\u0000' })

    const pr = await getPRForBranch('/repo-root', 'feature/test')

    expect(pr?.conflictSummary).toEqual({
      baseRef: 'main',
      baseCommit: 'latest-',
      commitsBehind: 3,
      files: ['src/a.ts', 'src/b.ts']
    })
  })

  it('routes local WSL branch status and conflict summary git probes through the selected distro', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 42,
          title: 'Fix PR discovery',
          state: 'open',
          html_url: 'https://github.com/acme/widgets/pull/42',
          updated_at: '2026-06-16T00:00:00Z',
          draft: false,
          mergeable_state: 'dirty',
          base: { ref: 'main', sha: 'base-oid' },
          head: { ref: 'feature/test', sha: 'head-oid' }
        }
      ])
    })
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: 'latest-base-oid\n' })
      .mockResolvedValueOnce({ stdout: 'merge-base-oid\n' })
      .mockResolvedValueOnce({ stdout: '2\n' })
      .mockResolvedValueOnce({ stdout: 'result-tree-oid\u0000src/conflict.ts\u0000' })

    const pr = await getPRForBranch('/repo-root', 'feature/test', null, null, null, {
      localGitExecOptions: { wslDistro: 'Ubuntu' }
    })

    expect(pr?.conflictSummary?.files).toEqual(['src/conflict.ts'])
    expect(resolvePRRepositoryCandidatesMock).toHaveBeenCalledWith('/repo-root', null, {
      wslDistro: 'Ubuntu'
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        cwd: '/repo-root',
        wslDistro: 'Ubuntu'
      })
    )
    expect(gitExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      ['fetch', '--quiet', 'origin', 'main'],
      {
        cwd: '/repo-root',
        timeout: 10_000,
        wslDistro: 'Ubuntu'
      }
    )
    expect(gitExecFileAsyncMock).toHaveBeenLastCalledWith(
      [
        'merge-tree',
        '--write-tree',
        '--name-only',
        '-z',
        '--no-messages',
        '--merge-base',
        'merge-base-oid',
        'head-oid',
        'latest-base-oid'
      ],
      {
        cwd: '/repo-root',
        wslDistro: 'Ubuntu'
      }
    )
  })

  it('treats GitHub DIRTY merge state as conflicting when mergeable is still unknown', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 42,
          title: 'Fix PR discovery',
          state: 'OPEN',
          url: 'https://github.com/acme/widgets/pull/42',
          statusCheckRollup: [],
          updatedAt: '2026-03-28T00:00:00Z',
          isDraft: false,
          mergeable: 'UNKNOWN',
          mergeStateStatus: 'DIRTY',
          baseRefName: 'main',
          headRefName: 'feature/test',
          baseRefOid: 'base-oid',
          headRefOid: 'head-oid'
        })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ data: { repository: { mergeQueue: null } } })
      })
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: 'latest-base-oid\n' })
      .mockResolvedValueOnce({ stdout: 'merge-base-oid\n' })
      .mockResolvedValueOnce({ stdout: '1\n' })
      .mockResolvedValueOnce({ stdout: 'result-tree-oid\u0000src/conflict.ts\u0000' })

    const pr = await getPRForBranch('/repo-root', 'feature/test', 42)

    expect(pr?.mergeable).toBe('CONFLICTING')
    expect(pr?.conflictSummary?.files).toEqual(['src/conflict.ts'])
  })

  it('omits conflict summaries for SSH-backed repos', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 42,
          title: 'Fix PR discovery',
          state: 'open',
          html_url: 'https://github.com/acme/widgets/pull/42',
          updated_at: '2026-03-28T00:00:00Z',
          draft: false,
          mergeable_state: 'dirty',
          base: { ref: 'main', sha: 'base-oid' },
          head: { ref: 'feature/test', sha: 'head-oid' }
        }
      ])
    })

    const pr = await getPRForBranch('/remote/repo-root', 'feature/test', undefined, 'ssh-1')

    expect(pr?.mergeable).toBe('CONFLICTING')
    expect(pr?.conflictSummary).toBeUndefined()
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('keeps conflicted file paths when git merge-tree exits 1 with stdout', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 42,
          title: 'Fix PR discovery',
          state: 'open',
          html_url: 'https://github.com/acme/widgets/pull/42',
          updated_at: '2026-03-28T00:00:00Z',
          draft: false,
          mergeable_state: 'dirty',
          base: { ref: 'main', sha: 'base-oid' },
          head: { ref: 'feature/test', sha: 'head-oid' }
        }
      ])
    })
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: 'latest-base-oid\n' })
      .mockResolvedValueOnce({ stdout: 'merge-base-oid\n' })
      .mockResolvedValueOnce({ stdout: '2\n' })
      .mockRejectedValueOnce({
        stdout: 'result-tree-oid\u0000src/conflict.ts\u0000'
      })

    const pr = await getPRForBranch('/repo-root', 'feature/test')

    expect(pr?.conflictSummary?.files).toEqual(['src/conflict.ts'])
  })

  it('falls back to the legacy merge-tree invocation when Git lacks --merge-base', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 42,
          title: 'Fix PR discovery',
          state: 'open',
          html_url: 'https://github.com/acme/widgets/pull/42',
          updated_at: '2026-03-28T00:00:00Z',
          draft: false,
          mergeable_state: 'dirty',
          base: { ref: 'main', sha: 'base-oid' },
          head: { ref: 'feature/test', sha: 'head-oid' }
        }
      ])
    })
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: 'latest-base-oid\n' })
      .mockResolvedValueOnce({ stdout: 'merge-base-oid\n' })
      .mockResolvedValueOnce({ stdout: '2\n' })
      .mockRejectedValueOnce({
        stderr: "error: unknown option `merge-base'"
      })
      .mockRejectedValueOnce({
        stdout: 'result-tree-oid\u0000src/conflict.ts\u0000'
      })

    const pr = await getPRForBranch('/repo-root', 'feature/test')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'merge-tree',
        '--write-tree',
        '--name-only',
        '-z',
        '--no-messages',
        '--merge-base',
        'merge-base-oid',
        'head-oid',
        'latest-base-oid'
      ],
      { cwd: '/repo-root' }
    )
    expect(gitExecFileAsyncMock).toHaveBeenLastCalledWith(
      [
        'merge-tree',
        '--write-tree',
        '--name-only',
        '-z',
        '--no-messages',
        'head-oid',
        'latest-base-oid'
      ],
      { cwd: '/repo-root' }
    )
    expect(pr?.conflictSummary?.files).toEqual(['src/conflict.ts'])
  })

  it('skips the unsupported merge-tree --merge-base retry after the first capability miss', async () => {
    getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    const branchLookup = {
      number: 42,
      title: 'Fix PR discovery',
      state: 'open',
      html_url: 'https://github.com/acme/widgets/pull/42',
      updated_at: '2026-03-28T00:00:00Z',
      draft: false,
      mergeable_state: 'dirty',
      base: { ref: 'main', sha: 'base-oid' },
      head: { ref: 'feature/test', sha: 'head-oid' }
    }
    const exactLookup = {
      number: 42,
      title: 'Fix PR discovery',
      state: 'OPEN',
      url: 'https://github.com/acme/widgets/pull/42',
      statusCheckRollup: [],
      updatedAt: '2026-03-28T00:00:00Z',
      isDraft: false,
      mergeable: 'CONFLICTING',
      baseRefName: 'main',
      headRefName: 'feature/test',
      baseRefOid: 'base-oid',
      headRefOid: 'head-oid'
    }
    // Why a second head OID: identical inputs now hit the summary result
    // cache outright; a pushed head re-derives and must still skip the
    // unsupported --merge-base retry via the capability cache.
    const pushedBranchLookup = { ...branchLookup, head: { ref: 'feature/test', sha: 'head-oid-2' } }
    const pushedExactLookup = { ...exactLookup, headRefOid: 'head-oid-2' }
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify([branchLookup]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify(exactLookup) })
      .mockResolvedValueOnce({ stdout: JSON.stringify([pushedBranchLookup]) })
      .mockResolvedValueOnce({ stdout: JSON.stringify(pushedExactLookup) })
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: 'latest-base-oid\n' })
      .mockResolvedValueOnce({ stdout: 'merge-base-oid\n' })
      .mockResolvedValueOnce({ stdout: '2\n' })
      .mockRejectedValueOnce({ stderr: "error: unknown option `merge-base'" })
      .mockRejectedValueOnce({ stdout: 'result-tree-oid\u0000src/conflict.ts\u0000' })
      .mockResolvedValueOnce({ stdout: 'merge-base-oid\n' })
      .mockResolvedValueOnce({ stdout: '2\n' })
      .mockRejectedValueOnce({ stdout: 'result-tree-oid\u0000src/conflict.ts\u0000' })

    await getPRForBranch('/repo-root', 'feature/test')
    await getPRForBranch('/repo-root', 'feature/test')

    const modernMergeTreeCalls = gitExecFileAsyncMock.mock.calls.filter(([args]) =>
      (args as string[]).includes('--merge-base')
    )
    const legacyMergeTreeCalls = gitExecFileAsyncMock.mock.calls.filter(([args]) => {
      const argv = args as string[]
      return argv[0] === 'merge-tree' && !argv.includes('--merge-base')
    })

    expect(modernMergeTreeCalls).toHaveLength(1)
    expect(legacyMergeTreeCalls).toHaveLength(2)
  })

  it('does not retry legacy merge-tree for older Git failures unrelated to --merge-base', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 42,
          title: 'Fix PR discovery',
          state: 'open',
          html_url: 'https://github.com/acme/widgets/pull/42',
          updated_at: '2026-03-28T00:00:00Z',
          draft: false,
          mergeable_state: 'dirty',
          base: { ref: 'main', sha: 'base-oid' },
          head: { ref: 'feature/test', sha: 'head-oid' }
        }
      ])
    })
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: 'latest-base-oid\n' })
      .mockResolvedValueOnce({ stdout: 'merge-base-oid\n' })
      .mockResolvedValueOnce({ stdout: '2\n' })
      .mockRejectedValueOnce({
        stderr: 'usage: git merge-tree <base-tree> <branch1> <branch2>'
      })

    const pr = await getPRForBranch('/repo-root', 'feature/test')

    expect(gitExecFileAsyncMock).toHaveBeenCalledTimes(5)
    expect(gitExecFileAsyncMock).toHaveBeenLastCalledWith(
      [
        'merge-tree',
        '--write-tree',
        '--name-only',
        '-z',
        '--no-messages',
        '--merge-base',
        'merge-base-oid',
        'head-oid',
        'latest-base-oid'
      ],
      { cwd: '/repo-root' }
    )
    expect(pr?.mergeable).toBe('CONFLICTING')
    expect(pr?.conflictSummary).toBeUndefined()
  })

  it('marks the conflict summary as locally clean when GitHub reports dirty but merge-tree has no conflicted files', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 42,
          title: 'Fix PR discovery',
          state: 'open',
          html_url: 'https://github.com/acme/widgets/pull/42',
          updated_at: '2026-06-20T22:16:43Z',
          draft: false,
          mergeable_state: 'dirty',
          base: { ref: 'main', sha: 'base-oid' },
          head: { ref: 'feature/test', sha: 'head-oid' }
        }
      ])
    })
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: 'latest-base-oid\n' })
      .mockResolvedValueOnce({ stdout: 'merge-base-oid\n' })
      .mockResolvedValueOnce({ stdout: '1\n' })
      .mockResolvedValueOnce({ stdout: 'result-tree-oid\u0000' })

    const pr = await getPRForBranch('/repo-root', 'feature/test')

    expect(pr?.mergeable).toBe('CONFLICTING')
    expect(pr?.conflictSummary).toEqual({
      baseRef: 'main',
      baseCommit: 'latest-',
      commitsBehind: 1,
      files: [],
      localMergeState: 'clean'
    })
  })

  it('falls back to GitHub baseRefOid when fetching or resolving the base ref fails', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify([
        {
          number: 42,
          title: 'Fix PR discovery',
          state: 'open',
          html_url: 'https://github.com/acme/widgets/pull/42',
          updated_at: '2026-03-28T00:00:00Z',
          draft: false,
          mergeable_state: 'dirty',
          base: { ref: 'main', sha: 'base-oid' },
          head: { ref: 'feature/test', sha: 'head-oid' }
        }
      ])
    })
    gitExecFileAsyncMock
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('missing refs/remotes/origin/main'))
      .mockRejectedValueOnce(new Error('missing origin/main'))
      .mockResolvedValueOnce({ stdout: 'merge-base-oid\n' })
      .mockResolvedValueOnce({ stdout: '1\n' })
      .mockResolvedValueOnce({ stdout: 'result-tree-oid\u0000src/fallback.ts\u0000' })

    const pr = await getPRForBranch('/repo-root', 'feature/test')

    expect(pr?.conflictSummary).toEqual({
      baseRef: 'main',
      baseCommit: 'base-oi',
      commitsBehind: 1,
      files: ['src/fallback.ts']
    })
  })

  it('returns null for empty branch (e.g. during rebase with detached HEAD)', async () => {
    const pr = await getPRForBranch('/repo-root', '')
    expect(pr).toBeNull()
    // Should not call gh at all
    expect(execFileAsyncMock).not.toHaveBeenCalled()
  })

  it('returns null for refs/heads/ only branch (detached after strip)', async () => {
    const pr = await getPRForBranch('/repo-root', 'refs/heads/')
    expect(pr).toBeNull()
    expect(execFileAsyncMock).not.toHaveBeenCalled()
  })

  it('uses fallback PR number for empty branch when detached', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 42,
        title: 'Detached fallback lookup',
        state: 'OPEN',
        url: 'https://github.com/acme/widgets/pull/42',
        statusCheckRollup: [],
        updatedAt: '2026-03-28T00:00:00Z',
        isDraft: false,
        mergeable: 'MERGEABLE',
        baseRefName: 'main',
        headRefName: 'feature/test',
        baseRefOid: 'base-oid',
        headRefOid: 'head-oid'
      })
    })

    const pr = await getPRForBranch('/repo-root', '', null, null, 42)

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      [
        'pr',
        'view',
        '42',
        '--repo',
        'acme/widgets',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid'
      ],
      { cwd: '/repo-root' }
    )
    expect(pr).toMatchObject({ number: 42, title: 'Detached fallback lookup' })
  })

  it('returns null when pr list returns an empty array', async () => {
    execFileAsyncMock
      .mockResolvedValueOnce({ stdout: 'git@github.com:acme/widgets.git\n' })
      .mockResolvedValueOnce({ stdout: '[]' })

    const pr = await getPRForBranch('/repo-root', 'no-pr-branch')

    expect(pr).toBeNull()
  })

  it('falls back to REST number lookup when linked PR GraphQL lookup is rate limited', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    gitExecFileAsyncMock.mockResolvedValueOnce({ stdout: 'linked-head-oid\n', stderr: '' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('GraphQL: API rate limit already exceeded'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 99,
          title: 'REST linked PR lookup',
          state: 'closed',
          merged_at: '2026-03-28T00:00:00Z',
          html_url: 'https://github.com/acme/widgets/pull/99',
          updated_at: '2026-03-28T00:00:00Z',
          draft: false,
          mergeable_state: 'clean',
          head: { ref: 'someone/fix', sha: 'linked-head-oid' },
          base: { ref: 'main', sha: 'linked-base-oid' }
        })
      })

    const pr = await getPRForBranch('/repo-root', 'feature/test', 99)

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      [
        'pr',
        'view',
        '99',
        '--repo',
        'acme/widgets',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid'
      ],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(2, ['api', 'repos/acme/widgets/pulls/99'], {
      cwd: '/repo-root'
    })
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(pr).toMatchObject({
      number: 99,
      state: 'merged',
      mergeable: 'MERGEABLE',
      headSha: 'linked-head-oid'
    })
  })

  it('resolves fork PR push target using the origin URL protocol', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    getOwnerRepoForRemoteMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        head: {
          ref: 'prateek/fix-sidebar-agents-toggle',
          repo: {
            full_name: 'prateek/orca',
            name: 'orca',
            clone_url: 'https://github.com/prateek/orca.git',
            ssh_url: 'git@github.com:prateek/orca.git',
            owner: { login: 'prateek' }
          }
        }
      })
    })
    getRemoteUrlForRepoMock.mockResolvedValueOnce('git@github.com:stablyai/orca.git')

    const target = await getPullRequestPushTarget('/repo-root', 1738)

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(['api', 'repos/stablyai/orca/pulls/1738'], {
      cwd: '/repo-root'
    })
    expect(target).toEqual({
      pushTarget: {
        remoteName: 'pr-prateek-orca',
        branchName: 'prateek/fix-sidebar-agents-toggle',
        remoteUrl: 'git@github.com:prateek/orca.git'
      }
    })
  })

  it('surfaces maintainer_can_modify=false alongside a fork PR push target', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    getOwnerRepoForRemoteMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        maintainer_can_modify: false,
        head: {
          ref: 'prateek/fix-sidebar-agents-toggle',
          repo: {
            full_name: 'prateek/orca',
            name: 'orca',
            clone_url: 'https://github.com/prateek/orca.git',
            ssh_url: 'git@github.com:prateek/orca.git',
            owner: { login: 'prateek' }
          }
        }
      })
    })
    getRemoteUrlForRepoMock.mockResolvedValueOnce('git@github.com:stablyai/orca.git')

    await expect(getPullRequestPushTarget('/repo-root', 1738)).resolves.toEqual({
      pushTarget: {
        remoteName: 'pr-prateek-orca',
        branchName: 'prateek/fix-sidebar-agents-toggle',
        remoteUrl: 'git@github.com:prateek/orca.git'
      },
      maintainerCanModify: false
    })
  })

  it('omits maintainerCanModify when the API does not report the flag', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    getOwnerRepoForRemoteMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        head: {
          ref: 'fix-sidebar',
          repo: {
            full_name: 'stablyai/orca',
            name: 'orca',
            clone_url: 'https://github.com/stablyai/orca.git',
            ssh_url: 'git@github.com:stablyai/orca.git',
            owner: { login: 'stablyai' }
          }
        }
      })
    })

    await expect(getPullRequestPushTarget('/repo-root', 1738)).resolves.toEqual({
      pushTarget: {
        remoteName: 'origin',
        branchName: 'fix-sidebar'
      }
    })
  })

  it('uses origin for same-repository PR push targets', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    getOwnerRepoForRemoteMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        head: {
          ref: 'fix-sidebar',
          repo: {
            full_name: 'stablyai/orca',
            name: 'orca',
            clone_url: 'https://github.com/stablyai/orca.git',
            ssh_url: 'git@github.com:stablyai/orca.git',
            owner: { login: 'stablyai' }
          }
        }
      })
    })

    await expect(getPullRequestPushTarget('/repo-root', 1738)).resolves.toEqual({
      pushTarget: {
        remoteName: 'origin',
        branchName: 'fix-sidebar'
      }
    })
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('keeps getRepoSlug origin-based on a fork checkout (#7331)', async () => {
    // The slug is the checkout's own identity (renderer display, icon
    // autodetect); it must not flip to the upstream parent.
    getOwnerRepoForRemoteMock.mockImplementation(async (_repoPath: string, remoteName: string) =>
      remoteName === 'origin'
        ? { owner: 'fsdwen', repo: 'orca' }
        : { owner: 'stablyai', repo: 'orca' }
    )

    await expect(getRepoSlug('/repo-root')).resolves.toEqual({ owner: 'fsdwen', repo: 'orca' })
    expect(getOwnerRepoForRemoteMock).toHaveBeenCalledWith('/repo-root', 'origin', undefined)
  })

  it('resolves a distinct upstream remote as the repo upstream', async () => {
    // getRepoUpstream probes origin then upstream via getOwnerRepoForRemote (#7331).
    getOwnerRepoForRemoteMock
      .mockResolvedValueOnce({ owner: 'tmchow', repo: 'orca' })
      .mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })

    await expect(getRepoUpstream('/repo-root')).resolves.toEqual({
      owner: 'stablyai',
      repo: 'orca'
    })

    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('does not treat a same-repository upstream remote as a fork', async () => {
    getOwnerRepoForRemoteMock
      .mockResolvedValueOnce({ owner: 'StablyAI', repo: 'Orca' })
      .mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({ isFork: false, parent: null })
    })

    await expect(getRepoUpstream('/repo-root')).resolves.toBeNull()

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['repo', 'view', 'StablyAI/Orca', '--json', 'isFork,parent'],
      { cwd: '/repo-root', timeout: 10_000 }
    )
  })

  it('does not mark an upstream-only GitHub remote as a fork', async () => {
    // Missing origin short-circuits before the upstream probe.
    getOwnerRepoForRemoteMock.mockResolvedValueOnce(null)

    await expect(getRepoUpstream('/repo-root')).resolves.toBeNull()

    expect(getOwnerRepoForRemoteMock).toHaveBeenCalledTimes(1)
    expect(getOwnerRepoForRemoteMock).toHaveBeenCalledWith('/repo-root', 'origin', undefined)
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('falls back to the GitHub parent when no upstream remote is configured', async () => {
    getOwnerRepoForRemoteMock
      .mockResolvedValueOnce({ owner: 'tmchow', repo: 'orca' })
      .mockResolvedValueOnce(null)
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        isFork: true,
        parent: { name: 'orca', owner: { login: 'stablyai' } }
      })
    })

    await expect(getRepoUpstream('/repo-root')).resolves.toEqual({
      owner: 'stablyai',
      repo: 'orca'
    })
  })

  it('probes additional PR repo candidates when the first lookup is not found', async () => {
    resolvePRRepositoryCandidatesMock.mockResolvedValueOnce({
      candidates: [
        { owner: 'fork', repo: 'orca' },
        { owner: 'stablyai', repo: 'orca' }
      ],
      headRepo: { owner: 'fork', repo: 'orca' }
    })
    getOwnerRepoForRemoteMock.mockResolvedValueOnce({ owner: 'fork', repo: 'orca' })
    ghExecFileAsyncMock
      .mockRejectedValueOnce(new Error('HTTP 404: Not Found'))
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          head: {
            ref: 'feature/test',
            repo: {
              full_name: 'fork/orca',
              name: 'orca',
              clone_url: 'https://github.com/fork/orca.git',
              ssh_url: 'git@github.com:fork/orca.git',
              owner: { login: 'fork' }
            }
          }
        })
      })

    await expect(getPullRequestPushTarget('/repo-root', 1849)).resolves.toEqual({
      pushTarget: {
        remoteName: 'origin',
        branchName: 'feature/test'
      }
    })
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(1, ['api', 'repos/fork/orca/pulls/1849'], {
      cwd: '/repo-root'
    })
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['api', 'repos/stablyai/orca/pulls/1849'],
      { cwd: '/repo-root' }
    )
  })

  it('normalizes reviewer avatars from REST pull request payloads', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 42,
        title: 'Review me',
        state: 'open',
        html_url: 'https://github.com/acme/widgets/pull/42',
        labels: [],
        updated_at: '2026-03-28T00:00:00Z',
        user: { login: 'author' },
        draft: false,
        requested_reviewers: [
          {
            login: 'AmethystLiang',
            avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4'
          }
        ]
      })
    })

    await expect(getWorkItem('/repo-root', 42, 'pr')).resolves.toMatchObject({
      reviewRequests: [
        {
          login: 'AmethystLiang',
          avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4'
        }
      ]
    })
  })
})

describe('updatePRState', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    getOwnerRepoMock.mockReset()
    ghRepoExecOptionsMock.mockClear()
    githubRepoContextMock.mockClear()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    _resetOwnerRepoCache()
  })

  it('reopens pull requests through the gh PR command', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '', stderr: '' })

    await expect(updatePRState('/repo-root', 3977, { state: 'open' })).resolves.toEqual({
      ok: true
    })

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['pr', 'reopen', '3977', '--repo', 'stablyai/orca'],
      { cwd: '/repo-root' }
    )
    expect(acquireMock).toHaveBeenCalledTimes(1)
    expect(releaseMock).toHaveBeenCalledTimes(1)
  })

  it('closes pull requests through the gh PR command', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '', stderr: '' })

    await expect(updatePRState('/repo-root', 3977, { state: 'closed' })).resolves.toEqual({
      ok: true
    })

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['pr', 'close', '3977', '--repo', 'stablyai/orca'],
      { cwd: '/repo-root' }
    )
  })

  it('reopens SSH-backed pull requests without local cwd options', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
    ghExecFileAsyncMock.mockResolvedValueOnce({ stdout: '', stderr: '' })

    await expect(
      updatePRState('/remote/repo-root', 3977, { state: 'open' }, 'ssh-1')
    ).resolves.toEqual({
      ok: true
    })

    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['pr', 'reopen', '3977', '--repo', 'stablyai/orca'],
      {}
    )
  })
})

describe('GitHub GraphQL rate-limit guard', () => {
  beforeEach(() => {
    execFileAsyncMock.mockReset()
    ghExecFileAsyncMock.mockReset()
    getOwnerRepoMock.mockReset()
    getIssueOwnerRepoMock.mockReset()
    getOwnerRepoForRemoteMock.mockReset()
    resolvePRRepositoryCandidatesMock.mockReset()
    resolvePRRepositoryCandidatesMock.mockImplementation(async (repoPath, connectionId) => {
      const origin = await getOwnerRepoMock(repoPath, connectionId)
      return { candidates: origin ? [origin] : [], headRepo: origin }
    })
    getRemoteUrlForRepoMock.mockReset()
    gitExecFileAsyncMock.mockReset()
    rateLimitGuardMock.mockReset()
    rateLimitGuardMock.mockReturnValue({ blocked: false })
    noteRateLimitSpendMock.mockReset()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    _resetOwnerRepoCache()
    _resetMergeQueueCacheForTests()
    __resetPRConflictSummaryCachesForTests()
  })

  it('skips PR review-thread GraphQL fetch while preserving REST comments', async () => {
    rateLimitGuardMock.mockImplementation(((bucket: string) =>
      bucket === 'graphql'
        ? { blocked: true, remaining: 4, limit: 5000, resetAt: 1_800_000_000 }
        : { blocked: false }) as () => RateLimitGuardResult)
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'acme', repo: 'widgets' })
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            id: 10,
            user: { login: 'octo', avatar_url: 'https://avatar', type: 'User' },
            body: 'top-level',
            created_at: '2026-04-01T00:00:00Z',
            html_url: 'https://github.com/acme/widgets/pull/7#issuecomment-10'
          }
        ])
      })
      .mockResolvedValueOnce({ stdout: '[]' })

    const comments = await getPRComments('/repo-root', 7)

    expect(comments).toHaveLength(1)
    expect(comments[0].body).toBe('top-level')
    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(ghExecFileAsyncMock.mock.calls.some((call) => call[0][1] === 'graphql')).toBe(false)
    expect(noteRateLimitSpendMock).not.toHaveBeenCalledWith('graphql')
  })

  it('uses explicit PR repo for comments when a fork PR is discovered', async () => {
    rateLimitGuardMock.mockImplementation(((bucket: string) =>
      bucket === 'graphql'
        ? { blocked: true, remaining: 4, limit: 5000, resetAt: 1_800_000_000 }
        : { blocked: false }) as () => RateLimitGuardResult)
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify([
          {
            id: 10,
            user: { login: 'octo', avatar_url: 'https://avatar', type: 'User' },
            body: 'top-level',
            created_at: '2026-04-01T00:00:00Z',
            html_url: 'https://github.com/stablyai/orca/pull/7#issuecomment-10'
          }
        ])
      })
      .mockResolvedValueOnce({ stdout: '[]' })

    await getPRComments('/repo-root', 7, { prRepo: { owner: 'stablyai', repo: 'orca' } }, undefined)

    expect(getOwnerRepoMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      ['api', '--cache', '60s', 'repos/stablyai/orca/issues/7/comments?per_page=100'],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['api', '--cache', '60s', 'repos/stablyai/orca/pulls/7/reviews?per_page=100'],
      { cwd: '/repo-root' }
    )
  })

  it('uses explicit PR repo for merge and title mutations', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 7,
          title: 'PR',
          state: 'OPEN',
          url: 'https://github.com/stablyai/orca/pull/7',
          statusCheckRollup: [],
          updatedAt: '2026-04-01T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          baseRefName: 'main',
          baseRefOid: 'base-oid',
          headRefOid: 'head-oid'
        })
      })
      .mockResolvedValue({ stdout: '', stderr: '' })

    await expect(
      mergePR('/repo-root', 7, 'squash', undefined, { owner: 'stablyai', repo: 'orca' })
    ).resolves.toEqual({ ok: true })
    await expect(
      updatePRTitle('/repo-root', 7, 'New title', undefined, { owner: 'stablyai', repo: 'orca' })
    ).resolves.toBe(true)

    expect(getOwnerRepoMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      [
        'pr',
        'view',
        '7',
        '--repo',
        'stablyai/orca',
        '--json',
        'number,title,state,url,statusCheckRollup,updatedAt,isDraft,mergeable,reviewDecision,mergeStateStatus,autoMergeRequest,baseRefName,headRefName,baseRefOid,headRefOid'
      ],
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['pr', 'merge', '7', '--squash', '--repo', 'stablyai/orca'],
      expect.objectContaining({
        cwd: '/repo-root',
        env: expect.objectContaining({ GH_PROMPT_DISABLED: '1' })
      })
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      ['pr', 'edit', '7', '--title', 'New title', '--repo', 'stablyai/orca'],
      { cwd: '/repo-root' }
    )
  })

  it('sets and disables PR auto-merge with explicit PR repos and SSH context', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ id: 'PR_kwDO123', headRefOid: 'head-oid' })
      })
      .mockResolvedValue({ stdout: '', stderr: '' })

    await expect(
      setPRAutoMerge('/remote/repo-root', 7, true, 'squash', 'ssh-1', {
        owner: 'stablyai',
        repo: 'orca'
      })
    ).resolves.toEqual({ ok: true })
    await expect(
      setPRAutoMerge('/remote/repo-root', 7, false, 'squash', 'ssh-1', {
        owner: 'stablyai',
        repo: 'orca'
      })
    ).resolves.toEqual({ ok: true })

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      ['pr', 'view', '7', '--json', 'id,headRefOid,baseRefName', '--repo', 'stablyai/orca'],
      {}
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining([
        'api',
        'graphql',
        '-f',
        'pullRequestId=PR_kwDO123',
        '-f',
        'mergeMethod=SQUASH',
        '-f',
        'expectedHeadOid=head-oid'
      ]),
      expect.objectContaining({
        env: expect.objectContaining({ GH_PROMPT_DISABLED: '1' })
      })
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      ['pr', 'merge', '7', '--disable-auto', '--repo', 'stablyai/orca'],
      expect.objectContaining({
        env: expect.objectContaining({ GH_PROMPT_DISABLED: '1' })
      })
    )
    expect(ghExecFileAsyncMock.mock.calls[0]?.[1]).not.toHaveProperty('cwd')
  })

  it('enables auto-merge without invoking the direct merge command', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ id: 'PR_kwDO123', headRefOid: 'head-oid' })
      })
      .mockResolvedValue({ stdout: '', stderr: '' })

    await expect(
      setPRAutoMerge('/repo-root', 7, true, 'squash', undefined, {
        owner: 'stablyai',
        repo: 'orca'
      })
    ).resolves.toEqual({ ok: true })

    expect(
      ghExecFileAsyncMock.mock.calls.some((call) =>
        (call[0] as string[]).some((arg) => arg.includes('enablePullRequestAutoMerge'))
      )
    ).toBe(true)
    expect(
      ghExecFileAsyncMock.mock.calls.some(
        (call) =>
          call[0][0] === 'pr' && call[0][1] === 'merge' && (call[0] as string[]).includes('--auto')
      )
    ).toBe(false)
  })

  it('translates the GitHub clean-status rejection into an actionable message', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ id: 'PR_kwDO123', headRefOid: 'head-oid' })
      })
      .mockRejectedValueOnce(new Error('GraphQL: Pull request is in clean status'))

    await expect(
      setPRAutoMerge('/repo-root', 7, true, 'squash', undefined, {
        owner: 'stablyai',
        repo: 'orca'
      })
    ).resolves.toEqual({
      ok: false,
      error: 'This pull request can already be merged. Use Merge instead of auto-merge.'
    })
  })

  it('uses the queue-aware gh merge path when the base branch has a merge queue', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ id: 'PR_kwDO123', headRefOid: 'head-oid', baseRefName: 'main' })
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ data: { repository: { mergeQueue: { id: 'MQ_kw' } } } })
      })
      .mockResolvedValue({ stdout: '', stderr: '' })

    await expect(
      setPRAutoMerge('/repo-root', 7, true, 'squash', undefined, {
        owner: 'stablyai',
        repo: 'orca'
      })
    ).resolves.toEqual({ ok: true })

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      expect.arrayContaining(['api', 'graphql', '-f', 'branch=main']),
      { cwd: '/repo-root' }
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      3,
      ['pr', 'merge', '7', '--auto', '--squash', '--repo', 'stablyai/orca'],
      expect.objectContaining({
        cwd: '/repo-root',
        env: expect.objectContaining({ GH_PROMPT_DISABLED: '1' })
      })
    )
    expect(
      ghExecFileAsyncMock.mock.calls.some((call) =>
        (call[0] as string[]).some((arg) => arg.includes('enablePullRequestAutoMerge'))
      )
    ).toBe(false)
  })

  it('blocks direct merge when GitHub reports required approval', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 7,
        title: 'PR',
        state: 'OPEN',
        url: 'https://github.com/stablyai/orca/pull/7',
        statusCheckRollup: [],
        updatedAt: '2026-04-01T00:00:00Z',
        isDraft: false,
        mergeable: 'MERGEABLE',
        reviewDecision: 'REVIEW_REQUIRED',
        mergeStateStatus: 'CLEAN',
        autoMergeRequest: null,
        baseRefName: 'main',
        baseRefOid: 'base-oid',
        headRefOid: 'head-oid'
      })
    })

    await expect(
      mergePR('/repo-root', 7, 'squash', undefined, { owner: 'stablyai', repo: 'orca' })
    ).resolves.toEqual({
      ok: false,
      error: 'This pull request requires review approval before it can be merged.'
    })

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(ghExecFileAsyncMock.mock.calls[1]?.[0]).toContain('graphql')
  })

  it('detects merge queues once per base branch and blocks direct merges', async () => {
    const prView = {
      number: 7,
      title: 'PR',
      state: 'OPEN',
      url: 'https://github.com/stablyai/orca/pull/7',
      statusCheckRollup: [],
      updatedAt: '2026-04-01T00:00:00Z',
      isDraft: false,
      mergeable: 'MERGEABLE',
      reviewDecision: 'APPROVED',
      mergeStateStatus: 'CLEAN',
      autoMergeRequest: null,
      baseRefName: 'true',
      baseRefOid: 'base-oid',
      headRefOid: 'head-oid'
    }
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify(prView) })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({ data: { repository: { mergeQueue: { id: 'MQ_kw' } } } })
      })
      .mockResolvedValueOnce({ stdout: JSON.stringify(prView) })

    await expect(
      mergePR('/repo-root', 7, 'squash', undefined, { owner: 'stablyai', repo: 'orca' })
    ).resolves.toEqual({
      ok: false,
      error:
        'This pull request must be merged through GitHub merge queue. Use Merge when ready instead.'
    })
    await expect(
      mergePR('/repo-root', 7, 'squash', undefined, { owner: 'stablyai', repo: 'orca' })
    ).resolves.toMatchObject({ ok: false })

    expect(
      ghExecFileAsyncMock.mock.calls.filter((call) => call[0].includes('graphql'))
    ).toHaveLength(1)
    expect(ghExecFileAsyncMock.mock.calls[1]?.[0]).toEqual(
      expect.arrayContaining(['-f', 'owner=stablyai', '-f', 'repo=orca', '-f', 'branch=true'])
    )
    expect(ghExecFileAsyncMock.mock.calls[1]?.[0]).not.toContain('-F')
  })

  it('caches unknown merge queue probes after GraphQL failures', async () => {
    getOwnerRepoMock.mockResolvedValue({ owner: 'stablyai', repo: 'orca' })
    const prView = {
      number: 7,
      title: 'PR',
      state: 'OPEN',
      url: 'https://github.com/stablyai/orca/pull/7',
      statusCheckRollup: [],
      updatedAt: '2026-04-01T00:00:00Z',
      isDraft: false,
      mergeable: 'MERGEABLE',
      reviewDecision: 'APPROVED',
      mergeStateStatus: 'CLEAN',
      autoMergeRequest: null,
      baseRefName: 'main',
      baseRefOid: 'base-oid',
      headRefOid: 'head-oid'
    }
    ghExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: JSON.stringify(prView) })
      .mockRejectedValueOnce(new Error('network is down'))
      .mockResolvedValueOnce({ stdout: JSON.stringify(prView) })

    await expect(getPRForBranch('/repo-root', 'feature/test', 7)).resolves.toMatchObject({
      mergeQueueRequired: null
    })
    await expect(getPRForBranch('/repo-root', 'feature/test', 7)).resolves.toMatchObject({
      mergeQueueRequired: null
    })

    expect(
      ghExecFileAsyncMock.mock.calls.filter((call) => call[0].includes('graphql'))
    ).toHaveLength(1)
  })

  it('bounds merge metadata cache entries across many base branches', async () => {
    getOwnerRepoMock.mockResolvedValue({ owner: 'stablyai', repo: 'orca' })
    let prViewCount = 0
    ghExecFileAsyncMock.mockImplementation(async (args) => {
      if (args.includes('graphql')) {
        return { stdout: JSON.stringify({ data: { repository: { mergeQueue: null } } }) }
      }
      prViewCount += 1
      return {
        stdout: JSON.stringify({
          number: prViewCount,
          title: 'PR',
          state: 'OPEN',
          url: `https://github.com/stablyai/orca/pull/${prViewCount}`,
          statusCheckRollup: [],
          updatedAt: '2026-04-01T00:00:00Z',
          isDraft: false,
          mergeable: 'MERGEABLE',
          reviewDecision: 'APPROVED',
          mergeStateStatus: 'CLEAN',
          autoMergeRequest: null,
          baseRefName: `base-${prViewCount}`,
          baseRefOid: 'base-oid',
          headRefOid: 'head-oid'
        })
      }
    })

    for (let i = 0; i < 260; i++) {
      await getPRForBranch('/repo-root', `feature/${i}`, i + 1)
    }

    expect(_getMergeQueueCacheSizeForTests()).toBe(256)
  })

  it('returns conflicting file details instead of running gh merge when PR is dirty', async () => {
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 7,
        title: 'PR',
        state: 'OPEN',
        url: 'https://github.com/stablyai/orca/pull/7',
        statusCheckRollup: [],
        updatedAt: '2026-04-01T00:00:00Z',
        isDraft: false,
        mergeable: 'CONFLICTING',
        baseRefName: 'main',
        baseRefOid: 'base-oid',
        headRefOid: 'head-oid'
      })
    })
    gitExecFileAsyncMock
      .mockResolvedValueOnce({ stdout: '' })
      .mockResolvedValueOnce({ stdout: 'latest-base-oid\n' })
      .mockResolvedValueOnce({ stdout: 'merge-base-oid\n' })
      .mockResolvedValueOnce({ stdout: '3\n' })
      .mockResolvedValueOnce({ stdout: 'result-tree-oid\u0000src/conflict.ts\u0000' })

    await expect(
      mergePR('/repo-root', 7, 'squash', undefined, { owner: 'stablyai', repo: 'orca' })
    ).resolves.toEqual({
      ok: false,
      error:
        'This pull request has merge conflicts and cannot be merged yet.\n' +
        '3 commits behind main (base commit: latest-).\n\n' +
        'Conflicting files:\n' +
        '- src/conflict.ts'
    })

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(1)
  })

  it('does not run merge conflict preflight for SSH-backed repos', async () => {
    ghExecFileAsyncMock
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          number: 7,
          title: 'PR',
          state: 'OPEN',
          url: 'https://github.com/stablyai/orca/pull/7',
          statusCheckRollup: [],
          updatedAt: '2026-04-01T00:00:00Z',
          isDraft: false,
          mergeable: 'CONFLICTING',
          baseRefName: 'main',
          baseRefOid: 'base-oid',
          headRefOid: 'head-oid'
        })
      })
      .mockResolvedValueOnce({ stdout: '', stderr: '' })

    await expect(
      mergePR('/remote/repo-root', 7, 'squash', 'ssh-1', { owner: 'stablyai', repo: 'orca' })
    ).resolves.toEqual({ ok: true })

    expect(ghExecFileAsyncMock).toHaveBeenCalledTimes(2)
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['pr', 'merge', '7', '--squash', '--repo', 'stablyai/orca'],
      expect.objectContaining({
        env: expect.objectContaining({ GH_PROMPT_DISABLED: '1' })
      })
    )
    expect(ghExecFileAsyncMock.mock.calls[0]?.[1]).not.toHaveProperty('cwd')
    expect(gitExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('blocks review-thread resolve mutations before spawning gh when GraphQL is low', async () => {
    rateLimitGuardMock.mockReturnValue({
      blocked: true,
      remaining: 4,
      limit: 5000,
      resetAt: 1_800_000_000
    })

    await expect(resolveReviewThread('/repo-root', 'thread-1', true)).resolves.toBe(false)

    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
    expect(noteRateLimitSpendMock).not.toHaveBeenCalled()
  })
})
