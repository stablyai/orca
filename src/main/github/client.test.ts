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
  rateLimitGuardMock: vi.fn<() => RateLimitGuardResult>(() => ({ blocked: false })),
  noteRateLimitSpendMock: vi.fn(),
  ghRepoExecOptionsMock: vi.fn((context) =>
    context.connectionId ? {} : { cwd: context.repoPath }
  ),
  githubRepoContextMock: vi.fn((repoPath, connectionId) => ({
    repoPath,
    connectionId: connectionId ?? null
  })),
  getSshGitProviderMock: vi.fn(),
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

vi.mock('./rate-limit', () => ({
  getRateLimit: getRateLimitMock,
  rateLimitGuard: rateLimitGuardMock,
  noteRateLimitSpend: noteRateLimitSpendMock
}))

import {
  getPRComments,
  getPRForBranch,
  getRepoUpstream,
  getWorkItem,
  getPullRequestPushTarget,
  mergePR,
  resolveReviewThread,
  setPRAutoMerge,
  updatePRState,
  updatePRTitle,
  _getMergeQueueCacheSizeForTests,
  _resetOwnerRepoCache,
  _resetMergeQueueCacheForTests
} from './client'

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
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    _resetOwnerRepoCache()
    _resetMergeQueueCacheForTests()
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
      stdout: 'origin/contributor/original\n',
      stderr: ''
    })

    const pr = await getPRForBranch('/repo-root', 'local-created-from-pr')

    expect(gitExecFileAsyncMock).toHaveBeenCalledWith(
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', 'local-created-from-pr@{upstream}'],
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
      stdout: 'fork/contributor/original\n',
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

  it('checks the tracked upstream branch through the SSH git provider', async () => {
    const sshGitProvider = {
      exec: vi.fn().mockResolvedValue({
        stdout: 'origin/contributor/original\n',
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
      ['rev-parse', '--abbrev-ref', '--symbolic-full-name', 'local-created-from-pr@{upstream}'],
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
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'git@github.com:stablyai/orca.git\n',
      stderr: ''
    })

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
    gitExecFileAsyncMock.mockResolvedValueOnce({
      stdout: 'git@github.com:stablyai/orca.git\n',
      stderr: ''
    })

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

  it('resolves a distinct upstream remote as the repo upstream', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'tmchow', repo: 'orca' })
    getOwnerRepoForRemoteMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })

    await expect(getRepoUpstream('/repo-root')).resolves.toEqual({
      owner: 'stablyai',
      repo: 'orca'
    })

    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('does not treat a same-repository upstream remote as a fork', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'StablyAI', repo: 'Orca' })
    getOwnerRepoForRemoteMock.mockResolvedValueOnce({ owner: 'stablyai', repo: 'orca' })
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
    getOwnerRepoMock.mockResolvedValueOnce(null)

    await expect(getRepoUpstream('/repo-root')).resolves.toBeNull()

    expect(getOwnerRepoForRemoteMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('falls back to the GitHub parent when no upstream remote is configured', async () => {
    getOwnerRepoMock.mockResolvedValueOnce({ owner: 'tmchow', repo: 'orca' })
    getOwnerRepoForRemoteMock.mockResolvedValueOnce(null)
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
    ghExecFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' })

    await expect(
      setPRAutoMerge('/remote/repo-root', 7, true, 'ssh-1', {
        owner: 'stablyai',
        repo: 'orca'
      })
    ).resolves.toEqual({ ok: true })
    await expect(
      setPRAutoMerge('/remote/repo-root', 7, false, 'ssh-1', {
        owner: 'stablyai',
        repo: 'orca'
      })
    ).resolves.toEqual({ ok: true })

    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      1,
      ['pr', 'merge', '7', '--auto', '--repo', 'stablyai/orca'],
      expect.objectContaining({
        env: expect.objectContaining({ GH_PROMPT_DISABLED: '1' })
      })
    )
    expect(ghExecFileAsyncMock).toHaveBeenNthCalledWith(
      2,
      ['pr', 'merge', '7', '--disable-auto', '--repo', 'stablyai/orca'],
      expect.objectContaining({
        env: expect.objectContaining({ GH_PROMPT_DISABLED: '1' })
      })
    )
    expect(ghExecFileAsyncMock.mock.calls[0]?.[1]).not.toHaveProperty('cwd')
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
