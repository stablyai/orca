import type * as GitExecFileModule from '../../git/command-runner/git-exec-file'
import type * as GithubRepositoryIdentityModule from './github-repository-identity'
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

vi.mock('../execution/github-legacy-command', () => ({
  execFileAsync: execFileAsyncMock
}))

vi.mock('../../git/command-runner/hosted-cli/gh-exec-file', () => ({
  ghExecFileAsync: ghExecFileAsyncMock
}))

vi.mock('../../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<typeof GitExecFileModule>()),
  gitExecFileAsync: gitExecFileAsyncMock
}))

vi.mock('../../git/command-runner/process-capture/exec-error', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  extractExecError: (err: unknown) => ({
    stderr: err instanceof Error ? err.message : String(err),
    stdout: ''
  })
}))

vi.mock('../execution/github-operation-slots', () => ({
  acquire: acquireMock,
  release: releaseMock
}))

vi.mock('./github-owner-repo-selection', () => ({
  getOwnerRepo: getOwnerRepoMock,
  resolvePRRepositoryCandidates: resolvePRRepositoryCandidatesMock,
  resolveIssueSource: vi.fn()
}))

vi.mock('./github-repository-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof GithubRepositoryIdentityModule>()),
  getOwnerRepoForRemote: getOwnerRepoForRemoteMock,
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

vi.mock('../api/gh-error-classification', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  classifyGhError: (message: string) => ({ type: 'unknown', message }),
  classifyListIssuesError: (message: string) => ({ type: 'unknown', message })
}))

vi.mock('./github-enterprise-repository', () => ({
  getEnterpriseGitHubRepoSlug: getEnterpriseGitHubRepoSlugMock,
  getEnterpriseGitHubRepoSlugForRemote: getEnterpriseGitHubRepoSlugMock,
  isGitHubHostAuthenticated: vi.fn().mockResolvedValue(true)
}))

vi.mock('../pull-requests/conflicts/conflict-summary', () => ({
  getPRConflictSummary: vi.fn()
}))

vi.mock('../api/rate-limit', () => ({
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
import { addPRReviewCommentReply } from '../client/create/add-pr-review-comment'
import { getPRChecks } from '../client/check/get-pr-checks'
import { getPRComments } from '../client/fetch/get-pr-comments'
import { mergePR } from '../client/merge/merge-pr'
import { removePRReviewers, requestPRReviewers } from '../client/update/pr-reviewers'
import { resolveReviewThread } from '../client/update/resolve-review-thread'
import { setPRAutoMerge } from '../client/merge/pr-auto-merge'
import { updatePRTitle } from '../client/update/pr-details'

import { _resetOriginGitHubApiRepositoryCache } from './github-api-repository-remote-probe'

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
})
