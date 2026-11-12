import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitHubEnterpriseRepository from './github-enterprise-repository'
import type * as GhUtils from './gh-utils'

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

vi.mock('./gh-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof GhUtils>()),
  getOwnerRepo: getOwnerRepoMock,
  getOwnerRepoForRemote: getOwnerRepoForRemoteMock
}))

vi.mock('./github-enterprise-repository', async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubEnterpriseRepository>()),
  getEnterpriseGitHubRepoSlug: getEnterpriseGitHubRepoSlugMock,
  isGitHubHostAuthenticated: isGitHubHostAuthenticatedMock
}))

vi.mock('../git/remotes/remote-name-listing', () => ({
  shouldProbeGitRemote: shouldProbeGitRemoteMock
}))
import {
  _resetOriginGitHubApiRepositoryCache,
  getGitHubApiRepositoryForRemote,
  getOriginGitHubApiRepository,
  resolveGitHubApiRepository,
  resolveGitHubApiRepositoryCandidates,
  resolveGitHubRepoExecution
} from './github-api-repository'

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

  it('does not reuse a tolerant SSH miss for verified candidate discovery', async () => {
    const enterprise = {
      owner: 'acme',
      repo: 'widgets',
      host: 'github.acme-corp.com'
    }
    getEnterpriseGitHubRepoSlugMock.mockResolvedValueOnce(null).mockResolvedValueOnce(enterprise)

    await expect(getOriginGitHubApiRepository('/remote/repo', 'ssh-1')).resolves.toBeNull()
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
    ).resolves.toEqual(enterprise)
    expect(getEnterpriseGitHubRepoSlugMock).toHaveBeenCalledTimes(2)
  })
})

describe('skip missing upstream remote probes', () => {
  it('observes and propagates a verified origin probe failure while listing remotes', async () => {
    let releaseRemoteProbe: (value: boolean) => void = () => undefined
    shouldProbeGitRemoteMock.mockReturnValue(
      new Promise<boolean>((resolve) => {
        releaseRemoteProbe = resolve
      })
    )
    const originError = new Error('origin probe failed')
    getOwnerRepoForRemoteMock.mockImplementation(async (_path, remote) => {
      if (remote === 'origin') {
        throw originError
      }
      return { owner: 'stablyai', repo: 'orca' }
    })

    const resultPromise = resolveGitHubApiRepositoryCandidates('/repo')
    await vi.waitFor(() =>
      expect(getOwnerRepoForRemoteMock).toHaveBeenCalledWith(
        '/repo',
        'origin',
        undefined,
        {},
        { requireVerifiedSshProbe: true }
      )
    )
    releaseRemoteProbe(true)

    await expect(resultPromise).rejects.toBe(originError)
  })
})
