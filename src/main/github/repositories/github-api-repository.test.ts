import type * as GithubOwnerRepoSelectionModule from './github-owner-repo-selection'
import type * as GithubRepositoryIdentityModule from './github-repository-identity'
import type * as GithubEnterpriseRepositoryModule from './github-enterprise-repository'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  getEnterpriseGitHubRepoSlugMock,
  getOwnerRepoMock,
  getOwnerRepoForRemoteMock,
  isGitHubHostAuthenticatedMock,
  shouldProbeGitRemoteMock
} = vi.hoisted(() => ({
  getEnterpriseGitHubRepoSlugMock: vi.fn(),
  getOwnerRepoMock: vi.fn(),
  getOwnerRepoForRemoteMock: vi.fn(),
  isGitHubHostAuthenticatedMock: vi.fn(),
  shouldProbeGitRemoteMock: vi.fn(async () => true)
}))

vi.mock('./github-owner-repo-selection', async (importOriginal) => ({
  ...(await importOriginal<typeof GithubOwnerRepoSelectionModule>()),
  getOwnerRepo: getOwnerRepoMock
}))

vi.mock('./github-repository-identity', async (importOriginal) => ({
  ...(await importOriginal<typeof GithubRepositoryIdentityModule>()),
  getOwnerRepoForRemote: getOwnerRepoForRemoteMock
}))

vi.mock('./github-enterprise-repository', async (importOriginal) => ({
  ...(await importOriginal<typeof GithubEnterpriseRepositoryModule>()),
  getEnterpriseGitHubRepoSlug: getEnterpriseGitHubRepoSlugMock,
  isGitHubHostAuthenticated: isGitHubHostAuthenticatedMock
}))

vi.mock('../../git/remotes/remote-name-listing', () => ({
  shouldProbeGitRemote: shouldProbeGitRemoteMock
}))
import {
  _resetOriginGitHubApiRepositoryCache,
  getGitHubApiRepositoryForRemote
} from './github-api-repository-remote-probe'
import { resolveGitHubApiRepository, resolveGitHubRepoExecution } from './github-api-repository'

beforeEach(() => {
  _resetOriginGitHubApiRepositoryCache()
  getEnterpriseGitHubRepoSlugMock.mockReset().mockResolvedValue(null)
  getOwnerRepoMock.mockReset().mockResolvedValue(null)
  getOwnerRepoForRemoteMock.mockReset().mockResolvedValue(null)
  isGitHubHostAuthenticatedMock.mockReset().mockResolvedValue(false)
  shouldProbeGitRemoteMock.mockReset().mockResolvedValue(true)
})

describe('resolveGitHubRepoExecution', () => {
  it('rejects an explicit Enterprise host absent from the local gh auth inventory', async () => {
    await expect(
      resolveGitHubApiRepository(
        '/remote/repo',
        {
          owner: 'acme',
          repo: 'widgets',
          host: 'evil.example.test'
        },
        'ssh-1'
      )
    ).resolves.toBeNull()

    expect(isGitHubHostAuthenticatedMock).toHaveBeenCalledWith(
      'evil.example.test',
      '/remote/repo',
      'ssh-1',
      {}
    )
  })

  it.each([
    { owner: 'acme%2Fadmin', repo: 'widgets' },
    { owner: 'acme', repo: '..' }
  ])('rejects repository overrides that could alter a gh REST path: %o', async (repository) => {
    await expect(
      resolveGitHubApiRepository('/repo', {
        ...repository,
        host: 'github.com'
      })
    ).resolves.toBeNull()

    expect(isGitHubHostAuthenticatedMock).not.toHaveBeenCalled()
  })

  it('rejects a host-less caller-specific resolver for a connection-backed repository', async () => {
    await expect(
      resolveGitHubRepoExecution(
        '/remote/repo',
        async () => ({ owner: 'upstream', repo: 'widgets' }),
        'ssh-1'
      )
    ).resolves.toEqual({ ownerRepo: null, ghOptions: {} })
  })

  it('preserves an authoritative null from a caller-specific resolver', async () => {
    getOwnerRepoMock.mockResolvedValue({ owner: 'origin', repo: 'widgets' })

    await expect(resolveGitHubRepoExecution('/repo', async () => null)).resolves.toEqual({
      ownerRepo: null,
      ghOptions: { cwd: '/repo' }
    })

    expect(getOwnerRepoMock).not.toHaveBeenCalled()
  })
})

describe('origin repository cache', () => {
  it('keeps an indeterminate auth inventory unverifiable during candidate discovery', async () => {
    getEnterpriseGitHubRepoSlugMock.mockResolvedValue(undefined)

    await expect(
      getGitHubApiRepositoryForRemote(
        '/remote/repo',
        'origin',
        'ssh-1',
        {},
        {
          requireVerifiedSshProbe: true
        }
      )
    ).rejects.toThrow('GitHub repository identity is unverifiable.')
  })
})
