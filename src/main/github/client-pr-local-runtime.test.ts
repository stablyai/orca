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

vi.mock('../providers/ssh-git-dispatch', () => ({
  getSshGitProvider: vi.fn()
}))

vi.mock('./conflict-summary', () => ({
  getPRConflictSummary: vi.fn()
}))

vi.mock('./rate-limit', () => ({
  getRateLimit: getRateLimitMock,
  rateLimitGuard: rateLimitGuardMock,
  noteRateLimitSpend: noteRateLimitSpendMock
}))

import {
  addPRReviewComment,
  addPRReviewCommentReply,
  getPRComments,
  mergePR,
  removePRReviewers,
  requestPRReviewers,
  resolveReviewThread,
  setPRAutoMerge,
  updatePRDetails,
  updatePRState,
  updatePRTitle
} from './client'

describe('GitHub PR local runtime routing', () => {
  beforeEach(() => {
    execFileAsyncMock.mockReset()
    ghExecFileAsyncMock.mockReset()
    getOwnerRepoMock.mockReset()
    getIssueOwnerRepoMock.mockReset()
    getOwnerRepoForRemoteMock.mockReset()
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
    getOwnerRepoMock.mockResolvedValue(prRepo)
    ghExecFileAsyncMock.mockImplementation(async (args: string[]) => {
      const endpoint = args.find((arg) => arg.startsWith('repos/acme/orca/')) ?? ''
      const query = args.find((arg) => arg.startsWith('query=')) ?? ''

      if (args[0] === 'pr' && args[1] === 'view') {
        return {
          stdout: JSON.stringify({
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
      resolveReviewThread('/repo-root', 'thread-1', true, null, localGitOptions)
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
      updatePRState('/repo-root', 7, { state: 'closed' }, null, localGitOptions)
    ).resolves.toEqual({ ok: true })
    await expect(
      requestPRReviewers('/repo-root', 7, ['octo'], null, localGitOptions)
    ).resolves.toEqual({ ok: true })
    await expect(
      removePRReviewers('/repo-root', 7, ['octo'], null, localGitOptions)
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
  })
})
