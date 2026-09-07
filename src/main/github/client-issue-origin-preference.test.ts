import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GithubApiRepositoryModule from './github-api-repository'
import type * as GhUtils from './gh-utils'

const {
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  getIssueOwnerRepoMock,
  getOwnerRepoForRemoteMock,
  resolvePRRepositoryCandidatesMock,
  resolveIssueSourceMock,
  rateLimitGuardMock,
  noteRateLimitSpendMock,
  acquireMock,
  releaseMock
} = vi.hoisted(() => ({
  ghExecFileAsyncMock: vi.fn(),
  getOwnerRepoMock: vi.fn(),
  getIssueOwnerRepoMock: vi.fn(),
  getOwnerRepoForRemoteMock: vi.fn(),
  resolvePRRepositoryCandidatesMock: vi.fn(),
  resolveIssueSourceMock: vi.fn(),
  rateLimitGuardMock: vi.fn(() => ({ blocked: false })),
  noteRateLimitSpendMock: vi.fn(),
  acquireMock: vi.fn(),
  releaseMock: vi.fn()
}))

vi.mock('./gh-utils', async () => {
  const actual = await vi.importActual<typeof GhUtils>('./gh-utils')
  return {
    ...actual,
    execFileAsync: vi.fn(),
    ghExecFileAsync: ghExecFileAsyncMock,
    getOwnerRepo: getOwnerRepoMock,
    getIssueOwnerRepo: getIssueOwnerRepoMock,
    getOwnerRepoForRemote: getOwnerRepoForRemoteMock,
    resolveIssueSource: resolveIssueSourceMock,
    acquire: acquireMock,
    release: releaseMock,
    _resetOwnerRepoCache: vi.fn()
  }
})

vi.mock('./rate-limit', () => ({
  rateLimitGuard: rateLimitGuardMock,
  noteRateLimitSpend: noteRateLimitSpendMock,
  getRateLimit: vi.fn(async () => ({ ok: false, error: 'not probed in tests' })),
  repositoryRateLimitGuard: vi.fn(() => ({ blocked: false })),
  noteRepositoryRateLimitSpend: vi.fn(),
  spendsSharedGitHubComQuota: () => true
}))

vi.mock('./github-api-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof GithubApiRepositoryModule>()
  return {
    ...actual,
    resolveIssueGitHubApiRepositorySource: (
      repoPath: string,
      preference: unknown,
      connectionId?: string | null,
      localGitOptions?: unknown
    ) => resolveIssueSourceMock(repoPath, preference, connectionId, localGitOptions),
    getIssueGitHubApiRepository: (repoPath: string, connectionId?: string | null) =>
      getIssueOwnerRepoMock(repoPath, connectionId),
    getOriginGitHubApiRepository: (
      repoPath: string,
      connectionId?: string | null,
      localGitOptions?: unknown
    ) => getOwnerRepoMock(repoPath, connectionId, localGitOptions),
    getGitHubApiRepositoryForRemote: (
      repoPath: string,
      remoteName: string,
      connectionId?: string | null,
      localGitOptions?: unknown
    ) =>
      remoteName === 'origin'
        ? getOwnerRepoMock(repoPath, connectionId, localGitOptions)
        : getOwnerRepoForRemoteMock(repoPath, remoteName, connectionId, localGitOptions),
    resolveGitHubApiRepositoryCandidates: (
      repoPath: string,
      connectionId?: string | null,
      localGitOptions?: unknown
    ) => resolvePRRepositoryCandidatesMock(repoPath, connectionId, localGitOptions)
  }
})

import { getWorkItem, _resetOwnerRepoCache } from './client'

describe('GitHub issue open-by-number origin preference', () => {
  beforeEach(() => {
    ghExecFileAsyncMock.mockReset()
    getOwnerRepoMock.mockReset()
    getIssueOwnerRepoMock.mockReset()
    getOwnerRepoForRemoteMock.mockReset()
    resolvePRRepositoryCandidatesMock.mockReset()
    resolveIssueSourceMock.mockReset()
    rateLimitGuardMock.mockReset()
    rateLimitGuardMock.mockReturnValue({ blocked: false })
    noteRateLimitSpendMock.mockReset()
    acquireMock.mockReset()
    releaseMock.mockReset()
    acquireMock.mockResolvedValue(undefined)
    getOwnerRepoForRemoteMock.mockImplementation(
      async (repoPath: string, remoteName: string, connectionId?: string | null, opts = {}) =>
        remoteName === 'origin' ? getOwnerRepoMock(repoPath, connectionId, opts) : null
    )
    resolvePRRepositoryCandidatesMock.mockImplementation(async (repoPath, connectionId) => {
      const origin = await getOwnerRepoMock(repoPath, connectionId)
      const repository = origin ? { host: 'github.com', ...origin } : null
      return { candidates: repository ? [repository] : [], headRepo: repository }
    })
    _resetOwnerRepoCache()
  })

  it('pins typed issue metadata to explicit origin preference', async () => {
    const source = { owner: 'fork', repo: 'orca', host: 'github.com' }
    resolveIssueSourceMock.mockResolvedValueOnce({ source, fellBack: false })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 7,
        title: 'Origin issue',
        state: 'open',
        labels: [],
        url: 'https://github.com/fork/orca/issues/7',
        updatedAt: '2026-04-02T00:00:00Z',
        author: { login: 'octocat' }
      })
    })

    const item = await getWorkItem('/repo-root', 7, 'issue', null, {}, 'origin')

    expect(resolveIssueSourceMock).toHaveBeenCalledWith('/repo-root', 'origin', null, {})
    expect(getIssueOwnerRepoMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).toHaveBeenCalledWith(
      ['api', 'repos/fork/orca/issues/7'],
      expect.objectContaining({ cwd: '/repo-root', host: 'github.com' })
    )
    expect(item).toMatchObject({ number: 7, title: 'Origin issue', type: 'issue' })
  })

  it('does not run a bare issue lookup when explicit origin identity is unresolved', async () => {
    resolveIssueSourceMock.mockResolvedValueOnce({ source: null, fellBack: false })

    await expect(getWorkItem('/repo-root', 7, 'issue', null, {}, 'origin')).resolves.toBeNull()

    expect(resolveIssueSourceMock).toHaveBeenCalledWith('/repo-root', 'origin', null, {})
    expect(getIssueOwnerRepoMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock).not.toHaveBeenCalled()
  })

  it('skips the issue probe on untyped open when origin identity is unresolved', async () => {
    const origin = { owner: 'fork', repo: 'orca', host: 'github.com' }
    resolveIssueSourceMock.mockResolvedValueOnce({ source: null, fellBack: false })
    getOwnerRepoMock.mockResolvedValue(origin)
    resolvePRRepositoryCandidatesMock.mockResolvedValue({ candidates: [origin], headRepo: origin })
    ghExecFileAsyncMock.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 7,
        title: 'Origin PR',
        state: 'open',
        labels: [],
        isDraft: false,
        url: 'https://github.com/fork/orca/pull/7',
        baseRefName: 'main',
        headRefName: 'origin/fix',
        updatedAt: '2026-04-02T00:00:00Z',
        author: { login: 'octocat' }
      })
    })

    const item = await getWorkItem('/repo-root', 7, undefined, null, {}, 'origin')

    expect(resolveIssueSourceMock).toHaveBeenCalledWith('/repo-root', 'origin', null, {})
    expect(getIssueOwnerRepoMock).not.toHaveBeenCalled()
    expect(ghExecFileAsyncMock.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining(['pr', 'view', '--repo', 'fork/orca'])
    )
    expect(item).toMatchObject({ number: 7, type: 'pr' })
  })
})
