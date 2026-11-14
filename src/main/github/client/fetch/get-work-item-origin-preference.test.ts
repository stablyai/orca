import type * as GithubLegacyCommandModule from '../../execution/github-legacy-command'
import type * as GhExecFileModule from '../../../git/command-runner/hosted-cli/gh-exec-file'
import type * as GithubOwnerRepoSelectionModule from '../../repositories/github-owner-repo-selection'
import type * as GithubRepositoryIdentityModule from '../../repositories/github-repository-identity'
import type * as GithubOperationSlotsModule from '../../execution/github-operation-slots'
import type * as GithubApiRepositoryModule from '../../repositories/github-api-repository'
import type * as GithubApiRepositoryRemoteProbeModule from '../../repositories/github-api-repository-remote-probe'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

vi.mock('../../execution/github-legacy-command', async () => {
  const actual = await vi.importActual<typeof GithubLegacyCommandModule>(
    '../../execution/github-legacy-command'
  )
  return {
    ...actual,
    execFileAsync: vi.fn()
  }
})

vi.mock('../../../git/command-runner/hosted-cli/gh-exec-file', async () => {
  const actual = await vi.importActual<typeof GhExecFileModule>(
    '../../../git/command-runner/hosted-cli/gh-exec-file'
  )
  return {
    ...actual,
    ghExecFileAsync: ghExecFileAsyncMock
  }
})

vi.mock('../../repositories/github-owner-repo-selection', async () => {
  const actual = await vi.importActual<typeof GithubOwnerRepoSelectionModule>(
    '../../repositories/github-owner-repo-selection'
  )
  return {
    ...actual,
    getOwnerRepo: getOwnerRepoMock,
    resolveIssueSource: resolveIssueSourceMock
  }
})

vi.mock('../../repositories/github-repository-identity', async () => {
  const actual = await vi.importActual<typeof GithubRepositoryIdentityModule>(
    '../../repositories/github-repository-identity'
  )
  return {
    ...actual,
    getOwnerRepoForRemote: getOwnerRepoForRemoteMock,
    _resetOwnerRepoCache: vi.fn()
  }
})

vi.mock('../../execution/github-operation-slots', async () => {
  const actual = await vi.importActual<typeof GithubOperationSlotsModule>(
    '../../execution/github-operation-slots'
  )
  return {
    ...actual,
    acquire: acquireMock,
    release: releaseMock
  }
})

vi.mock('../../api/rate-limit', () => ({
  rateLimitGuard: rateLimitGuardMock,
  noteRateLimitSpend: noteRateLimitSpendMock,
  getRateLimit: vi.fn(async () => ({ ok: false, error: 'not probed in tests' })),
  repositoryRateLimitGuard: vi.fn(() => ({ blocked: false })),
  noteRepositoryRateLimitSpend: vi.fn(),
  spendsSharedGitHubComQuota: () => true
}))

vi.mock('../../repositories/github-api-repository', async (importOriginal) => {
  return {
    ...(await importOriginal<typeof GithubApiRepositoryModule>()),
    resolveIssueGitHubApiRepositorySource: (
      repoPath: string,
      preference: unknown,
      connectionId?: string | null,
      localGitOptions?: unknown
    ) => resolveIssueSourceMock(repoPath, preference, connectionId, localGitOptions),
    getIssueGitHubApiRepository: (repoPath: string, connectionId?: string | null) =>
      getIssueOwnerRepoMock(repoPath, connectionId),
    resolveGitHubApiRepositoryCandidates: (
      repoPath: string,
      connectionId?: string | null,
      localGitOptions?: unknown
    ) => resolvePRRepositoryCandidatesMock(repoPath, connectionId, localGitOptions)
  }
})

vi.mock('../../repositories/github-api-repository-remote-probe', async (importOriginal) => {
  return {
    ...(await importOriginal<typeof GithubApiRepositoryRemoteProbeModule>()),
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
        : getOwnerRepoForRemoteMock(repoPath, remoteName, connectionId, localGitOptions)
  }
})

import { getWorkItem } from './get-work-item'
import { _resetOwnerRepoCache } from '../../repositories/github-repository-identity'

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
