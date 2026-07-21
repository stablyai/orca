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
  getEnterpriseGitHubRepoSlugMock,
  resolvePRRepositoryCandidatesMock,
  getRemoteUrlForRepoMock,
  gitExecFileAsyncMock,
  getRateLimitMock,
  rateLimitGuardMock,
  noteRateLimitSpendMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  execFileAsyncMock: vi.fn(),
  ghExecFileAsyncMock: vi.fn(),
  getOwnerRepoMock: vi.fn(),
  getIssueOwnerRepoMock: vi.fn(),
  getOwnerRepoForRemoteMock: vi.fn(),
  getEnterpriseGitHubRepoSlugMock: vi.fn(),
  resolvePRRepositoryCandidatesMock: vi.fn(),
  getRemoteUrlForRepoMock: vi.fn(),
  gitExecFileAsyncMock: vi.fn(),
  getRateLimitMock: vi.fn(),
  rateLimitGuardMock: vi.fn<() => RateLimitGuardResult>(() => ({ blocked: false })),
  noteRateLimitSpendMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gh-utils', () => ({
  execFileAsync: execFileAsyncMock,
  ghExecFileAsync: ghExecFileAsyncMock,
  gitExecFileAsync: gitExecFileAsyncMock,
  extractExecError: (err: unknown) => ({
    stderr: err instanceof Error ? err.message : String(err),
    stdout: ''
  }),
  acquire: acquireMock,
  release: releaseMock,
  getOwnerRepo: getOwnerRepoMock,
  getIssueOwnerRepo: getIssueOwnerRepoMock,
  getOwnerRepoForRemote: getOwnerRepoForRemoteMock,
  resolvePRRepositoryCandidates: resolvePRRepositoryCandidatesMock,
  resolveIssueSource: vi.fn(),
  classifyGhError: (message: string) => ({ type: 'unknown', message }),
  classifyListIssuesError: (message: string) => ({ type: 'unknown', message }),
  ghRepoExecOptions: (context: {
    repoPath: string
    connectionId?: string | null
    wslDistro?: string
  }) =>
    context.connectionId
      ? {}
      : { cwd: context.repoPath, ...(context.wslDistro ? { wslDistro: context.wslDistro } : {}) },
  githubRepoContext: (
    repoPath: string,
    connectionId?: string | null,
    localGitOptions: { wslDistro?: string } = {}
  ) => ({
    repoPath,
    connectionId: connectionId ?? null,
    ...localGitOptions
  }),
  getRemoteUrlForRepo: getRemoteUrlForRepoMock,
  _resetOwnerRepoCache: vi.fn()
}))

vi.mock('../git/runner', () => ({
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('./github-enterprise-repository', () => ({
  getEnterpriseGitHubRepoSlug: getEnterpriseGitHubRepoSlugMock,
  getEnterpriseGitHubRepoSlugForRemote: getEnterpriseGitHubRepoSlugMock,
  isGitHubHostAuthenticated: vi.fn().mockResolvedValue(true)
}))

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: vi.fn()
}))

vi.mock('./conflict-summary', () => ({
  getPRConflictSummary: vi.fn()
}))

vi.mock('./rate-limit', () => ({
  getRateLimit: getRateLimitMock,
  rateLimitGuard: rateLimitGuardMock,
  noteRateLimitSpend: noteRateLimitSpendMock,
  repositoryRateLimitGuard: vi.fn(() => ({ blocked: false })),
  noteRepositoryRateLimitSpend: vi.fn(),
  spendsSharedGitHubComQuota: (
    repository?: { host?: string } | null,
    executionOptions?: { wslDistro?: string }
  ) =>
    (!repository?.host || repository.host.toLowerCase() === 'github.com') &&
    !executionOptions?.wslDistro
}))

import {
  addPRReviewComment,
  addPRReviewCommentReply,
  getPRCheckDetails,
  getPRChecks,
  getWorkItemByOwnerRepo,
  getPRComments,
  mergePR,
  removePRReviewers,
  rerunPRChecks,
  requestPRReviewers,
  resolveReviewThread,
  setPRAutoMerge,
  updatePRDetails,
  updatePRState,
  updatePRTitle
} from './client'

import { _resetOriginGitHubApiRepositoryCache } from './github-api-repository'

// The origin-repository cache is module-level state; reset it so slugs
// resolved by one test cannot leak into the next.
beforeEach(() => {
  _resetOriginGitHubApiRepositoryCache()
})

describe('GitHub PR local runtime routing', () => {
  beforeEach(() => {
    execFileAsyncMock.mockReset()
    ghExecFileAsyncMock.mockReset()
    getOwnerRepoMock.mockReset()
    getIssueOwnerRepoMock.mockReset()
    getOwnerRepoForRemoteMock.mockReset()
    // Why: host-less prRepo backfill and origin resolution use getOwnerRepoForRemote.
    getOwnerRepoForRemoteMock.mockImplementation(
      async (repoPath: string, remoteName: string, connectionId?: string | null, opts = {}) =>
        remoteName === 'origin' ? getOwnerRepoMock(repoPath, connectionId, opts) : null
    )
    getEnterpriseGitHubRepoSlugMock.mockReset()
    getEnterpriseGitHubRepoSlugMock.mockResolvedValue(null)
    resolvePRRepositoryCandidatesMock.mockReset()
    getRemoteUrlForRepoMock.mockReset()
    gitExecFileAsyncMock.mockReset()
    getRateLimitMock.mockReset()
    getRateLimitMock.mockResolvedValue({ resources: {} })
    rateLimitGuardMock.mockReset()
    rateLimitGuardMock.mockReturnValue({ blocked: false })
    noteRateLimitSpendMock.mockReset()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
  })

  it('routes PR details and mutations through the selected WSL distro', async () => {
    const localGitOptions = { wslDistro: 'Ubuntu' }
    const prRepo = { owner: 'acme', repo: 'orca' }
    rateLimitGuardMock.mockReturnValue({
      blocked: true,
      remaining: 0,
      limit: 5000,
      resetAt: 1_800_000_000
    })
    getOwnerRepoMock.mockResolvedValue(prRepo)
    ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const endpoint = args.find((arg) => arg.startsWith('repos/acme/orca/')) ?? ''
      const query = args.find((arg) => arg.startsWith('query=')) ?? ''

      if (args[0] === 'pr' && args[1] === 'view') {
        const jsonFields = args[args.indexOf('--json') + 1]
        if (jsonFields === 'id,headRefOid,baseRefName') {
          return {
            stdout: JSON.stringify({
              id: 'PR_local',
              headRefOid: 'head-oid',
              baseRefName: 'main'
            })
          }
        }
        return {
          stdout: JSON.stringify({
            id: 'PR_kwDO123',
            number: 7,
            title: 'PR',
            state: 'OPEN',
            url: 'https://github.com/acme/orca/pull/7',
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
          })
        }
      }
      if (query.includes('reviewThreads')) {
        return {
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: { nodes: [] },
                  comments: { nodes: [] }
                }
              }
            }
          })
        }
      }
      if (endpoint.endsWith('/issues/7/comments?per_page=100')) {
        return { stdout: '[]' }
      }
      if (endpoint.endsWith('/pulls/7/reviews?per_page=100')) {
        return { stdout: '[]' }
      }
      if (endpoint.endsWith('/pulls/7/comments/11/replies')) {
        return { stdout: JSON.stringify({ id: 12, user: null, body: 'Reply' }) }
      }
      if (endpoint.endsWith('/pulls/7/comments')) {
        return { stdout: JSON.stringify({ id: 13, user: null, body: 'Inline' }) }
      }
      return { stdout: '', stderr: '' }
    })

    await getPRComments('/repo-root', 7, { prRepo }, null, localGitOptions)
    await expect(
      resolveReviewThread('/repo-root', 'thread-1', true, null, prRepo, localGitOptions)
    ).resolves.toBe(true)
    await expect(
      addPRReviewCommentReply(
        '/repo-root',
        7,
        11,
        'Reply',
        'thread-1',
        'src/app.ts',
        10,
        null,
        prRepo,
        localGitOptions
      )
    ).resolves.toMatchObject({ ok: true })
    await expect(
      addPRReviewComment({
        repoPath: '/repo-root',
        connectionId: null,
        localGitOptions,
        prRepo,
        prNumber: 7,
        body: 'Inline',
        commitId: 'head-oid',
        path: 'src/app.ts',
        line: 10
      })
    ).resolves.toMatchObject({ ok: true })
    await expect(
      updatePRTitle('/repo-root', 7, 'New title', null, prRepo, localGitOptions)
    ).resolves.toBe(true)
    await expect(
      updatePRDetails('/repo-root', 7, { body: 'New body' }, null, prRepo, localGitOptions)
    ).resolves.toEqual({ ok: true })
    await expect(
      updatePRState('/repo-root', 7, { state: 'closed' }, null, prRepo, localGitOptions)
    ).resolves.toEqual({ ok: true })
    await expect(
      requestPRReviewers('/repo-root', 7, ['octo'], null, prRepo, localGitOptions)
    ).resolves.toEqual({ ok: true })
    await expect(
      removePRReviewers('/repo-root', 7, ['octo'], null, prRepo, localGitOptions)
    ).resolves.toEqual({ ok: true })
    await expect(
      setPRAutoMerge('/repo-root', 7, true, 'squash', null, prRepo, localGitOptions)
    ).resolves.toEqual({ ok: true })
    await expect(
      mergePR('/repo-root', 7, 'squash', null, prRepo, localGitOptions)
    ).resolves.toEqual({ ok: true })

    expect(getOwnerRepoMock).toHaveBeenCalledWith('/repo-root', null, localGitOptions)
    expect(ghExecFileAsyncMock.mock.calls.every((call) => call[1]?.wslDistro === 'Ubuntu')).toBe(
      true
    )
    expect(getRateLimitMock).not.toHaveBeenCalled()
    expect(rateLimitGuardMock).not.toHaveBeenCalled()
    expect(noteRateLimitSpendMock).not.toHaveBeenCalled()
  })

  it('never falls through to the default gh host for an unresolved SSH repository', async () => {
    const legacyRepo = { owner: 'team', repo: 'orca' }
    getOwnerRepoMock.mockResolvedValue(null)
    getEnterpriseGitHubRepoSlugMock.mockResolvedValue(null)

    await expect(getPRComments('/remote/repo', 7, { prRepo: legacyRepo }, 'ssh-1')).rejects.toThrow(
      'GitHub remote'
    )
    await expect(
      getPRChecks('/remote/repo', 7, undefined, legacyRepo, undefined, 'ssh-1')
    ).rejects.toThrow('GitHub remote')
    await expect(mergePR('/remote/repo', 7, 'squash', 'ssh-1', legacyRepo)).resolves.toMatchObject({
      ok: false
    })
    await expect(
      setPRAutoMerge('/remote/repo', 7, true, 'squash', 'ssh-1', legacyRepo)
    ).resolves.toMatchObject({ ok: false })
    await expect(updatePRTitle('/remote/repo', 7, 'New title', 'ssh-1', legacyRepo)).resolves.toBe(
      false
    )
    await expect(requestPRReviewers('/remote/repo', 7, ['octo'], 'ssh-1')).resolves.toMatchObject({
      ok: false
    })
    await expect(removePRReviewers('/remote/repo', 7, ['octo'], 'ssh-1')).resolves.toMatchObject({
      ok: false
    })
    await expect(
      addPRReviewCommentReply(
        '/remote/repo',
        7,
        11,
        'Reply',
        undefined,
        undefined,
        undefined,
        'ssh-1',
        legacyRepo
      )
    ).resolves.toMatchObject({ ok: false })

    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('refuses unresolved local PR mutations instead of using ambient gh defaults', async () => {
    const legacyRepo = { owner: 'team', repo: 'orca' }
    getOwnerRepoMock.mockResolvedValue(null)
    getEnterpriseGitHubRepoSlugMock.mockResolvedValue(null)

    await expect(
      resolveReviewThread('/repo-root', 'thread-1', true, null, legacyRepo)
    ).resolves.toBe(false)
    await expect(updatePRTitle('/repo-root', 7, 'New title', null, legacyRepo)).resolves.toBe(false)
    await expect(
      requestPRReviewers('/repo-root', 7, ['octo'], null, legacyRepo)
    ).resolves.toMatchObject({ ok: false })
    await expect(
      removePRReviewers('/repo-root', 7, ['octo'], null, legacyRepo)
    ).resolves.toMatchObject({ ok: false })
    await expect(mergePR('/repo-root', 7, 'squash', null, legacyRepo)).resolves.toMatchObject({
      ok: false
    })
    await expect(
      setPRAutoMerge('/repo-root', 7, true, 'squash', null, legacyRepo)
    ).resolves.toMatchObject({ ok: false })

    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('host-qualifies SSH-backed GitHub Enterprise review reads and mutations', async () => {
    const enterpriseRepo = {
      owner: 'team',
      repo: 'orca',
      host: 'github.acme-corp.com'
    }
    getOwnerRepoMock.mockResolvedValue(null)
    getEnterpriseGitHubRepoSlugMock.mockResolvedValue(enterpriseRepo)
    ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const endpoint = args.find((arg) => arg.startsWith('repos/team/orca/')) ?? ''
      const query = args.find((arg) => arg.startsWith('query=')) ?? ''
      if (args[0] === 'pr' && args[1] === 'checks') {
        return { stdout: '[]' }
      }
      if (args[0] === 'pr' && args[1] === 'view') {
        if (args.includes('id,headRefOid,baseRefName')) {
          return {
            stdout: JSON.stringify({
              id: 'PR_enterprise',
              headRefOid: 'head-sha',
              baseRefName: 'main'
            })
          }
        }
        return {
          stdout: JSON.stringify({
            number: 7,
            title: 'Enterprise PR',
            state: 'OPEN',
            url: 'https://github.acme-corp.com/team/orca/pull/7',
            labels: [],
            updatedAt: '2026-07-16T00:00:00Z',
            author: { login: 'pr-author' },
            headRefName: 'feature',
            baseRefName: 'main'
          })
        }
      }
      if (query.includes('reviewThreads')) {
        return {
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: { nodes: [] },
                  comments: { nodes: [] }
                }
              }
            }
          })
        }
      }
      if (
        endpoint.endsWith('/issues/7/comments?per_page=100') ||
        endpoint.endsWith('/pulls/7/reviews?per_page=100')
      ) {
        return { stdout: '[]' }
      }
      if (endpoint.endsWith('/commits/head-sha/check-runs?per_page=100')) {
        return {
          stdout: JSON.stringify({
            check_runs: [
              {
                id: 88,
                name: 'lint',
                status: 'completed',
                conclusion: 'failure',
                details_url: 'https://github.acme-corp.com/team/orca/actions/runs/77/job/88'
              }
            ]
          })
        }
      }
      if (endpoint.endsWith('/commits/head-sha/status?per_page=100')) {
        return { stdout: JSON.stringify({ statuses: [] }) }
      }
      if (endpoint.endsWith('/commits/head-sha/check-suites?per_page=100')) {
        return { stdout: JSON.stringify({ check_suites: [] }) }
      }
      if (endpoint.endsWith('/check-runs/88')) {
        return {
          stdout: JSON.stringify({
            id: 88,
            name: 'lint',
            status: 'completed',
            conclusion: 'failure',
            details_url: 'https://github.acme-corp.com/team/orca/actions/runs/77/job/88',
            output: { title: 'Lint failed', summary: 'One error' }
          })
        }
      }
      if (endpoint.endsWith('/check-runs/88/annotations?per_page=20')) {
        return { stdout: '[]' }
      }
      if (query) {
        return { stdout: JSON.stringify({ data: { repository: {} } }) }
      }
      return {
        stdout: JSON.stringify({
          id: 13,
          user: null,
          body: 'Enterprise inline comment'
        })
      }
    })

    await expect(
      getWorkItemByOwnerRepo('/remote/repo', enterpriseRepo, 7, 'pr', 'ssh-1')
    ).resolves.toMatchObject({ number: 7, title: 'Enterprise PR' })
    await expect(
      getWorkItemByOwnerRepo('/remote/repo', { owner: 'team', repo: 'orca' }, 7, 'pr', 'ssh-1')
    ).resolves.toMatchObject({ number: 7, title: 'Enterprise PR' })
    await expect(
      getPRComments('/remote/repo', 7, { prRepo: enterpriseRepo }, 'ssh-1')
    ).resolves.toEqual([])
    await expect(
      getPRChecks('/remote/repo', 7, undefined, enterpriseRepo, undefined, 'ssh-1')
    ).resolves.toEqual([])
    await expect(
      getPRCheckDetails('/remote/repo', { checkRunId: 88, prRepo: enterpriseRepo }, 'ssh-1')
    ).resolves.toMatchObject({ name: 'lint', conclusion: 'failure' })
    await expect(
      rerunPRChecks(
        '/remote/repo',
        7,
        { headSha: 'head-sha', failedOnly: true, prRepo: enterpriseRepo },
        'ssh-1'
      )
    ).resolves.toEqual({ ok: true, count: 1 })
    await expect(
      resolveReviewThread('/remote/repo', 'thread-1', true, 'ssh-1', enterpriseRepo)
    ).resolves.toBe(true)
    await expect(
      addPRReviewCommentReply(
        '/remote/repo',
        7,
        11,
        'Enterprise reply',
        'thread-1',
        'src/enterprise.ts',
        10,
        'ssh-1',
        enterpriseRepo
      )
    ).resolves.toMatchObject({ ok: true })
    await expect(
      addPRReviewComment({
        repoPath: '/remote/repo',
        connectionId: 'ssh-1',
        prRepo: enterpriseRepo,
        prNumber: 7,
        body: 'Enterprise inline comment',
        commitId: 'head-sha',
        path: 'src/enterprise.ts',
        line: 10
      })
    ).resolves.toMatchObject({ ok: true })
    await expect(
      updatePRTitle('/remote/repo', 7, 'New title', 'ssh-1', enterpriseRepo)
    ).resolves.toBe(true)
    await expect(
      updatePRDetails('/remote/repo', 7, { body: 'New body' }, 'ssh-1', enterpriseRepo)
    ).resolves.toEqual({ ok: true })
    await expect(
      updatePRState('/remote/repo', 7, { state: 'closed' }, 'ssh-1', enterpriseRepo)
    ).resolves.toEqual({
      ok: true
    })
    await expect(
      requestPRReviewers('/remote/repo', 7, ['octo'], 'ssh-1', enterpriseRepo)
    ).resolves.toEqual({
      ok: true
    })
    await expect(
      removePRReviewers('/remote/repo', 7, ['octo'], 'ssh-1', enterpriseRepo)
    ).resolves.toEqual({
      ok: true
    })
    await expect(
      setPRAutoMerge('/remote/repo', 7, true, 'squash', 'ssh-1', enterpriseRepo)
    ).resolves.toEqual({ ok: true })
    await expect(
      setPRAutoMerge('/remote/repo', 7, false, 'squash', 'ssh-1', enterpriseRepo)
    ).resolves.toEqual({ ok: true })
    await expect(mergePR('/remote/repo', 7, 'squash', 'ssh-1', enterpriseRepo)).resolves.toEqual({
      ok: true
    })

    const prViewCall = ghExecFileAsyncMock.mock.calls.find(
      ([args]) => args[0] === 'pr' && args[1] === 'view'
    )
    // The runner host-qualifies argv at spawn time from options.host, so the
    // mocked call sees the unqualified --repo plus the host in exec options.
    expect(prViewCall?.[0]).toEqual(expect.arrayContaining(['--repo', 'team/orca']))
    expect(prViewCall?.[1]).toEqual({ host: 'github.acme-corp.com' })
    const prCalls = ghExecFileAsyncMock.mock.calls.filter(([args]) => args[0] === 'pr')
    expect(
      prCalls.every(
        ([args]) => args.includes('--repo') && args[args.indexOf('--repo') + 1] === 'team/orca'
      )
    ).toBe(true)
    const apiCalls = ghExecFileAsyncMock.mock.calls.filter(([args]) => args[0] === 'api')
    expect(apiCalls.length).toBeGreaterThan(0)
    expect(
      apiCalls.every(
        ([args, options]) =>
          !args.includes('--hostname') &&
          options.host === 'github.acme-corp.com' &&
          options.cwd === undefined &&
          options.wslDistro === undefined
      )
    ).toBe(true)
  })
})
