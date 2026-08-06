import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GitHubEnterpriseRepository from './github-enterprise-repository'
import type * as GhUtils from './gh-utils'

const {
  getEnterpriseGitHubRepoSlugMock,
  getOwnerRepoMock,
  getOwnerRepoForRemoteMock,
  isGitHubHostAuthenticatedMock
} = vi.hoisted(() => ({
  getEnterpriseGitHubRepoSlugMock: vi.fn(),
  getOwnerRepoMock: vi.fn(),
  getOwnerRepoForRemoteMock: vi.fn(),
  isGitHubHostAuthenticatedMock: vi.fn()
}))

vi.mock('./gh-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof GhUtils>()),
  getOwnerRepo: getOwnerRepoMock,
  // Why: origin resolution uses getOwnerRepoForRemote, not getOwnerRepo.
  getOwnerRepoForRemote: getOwnerRepoForRemoteMock
}))

vi.mock('./github-enterprise-repository', async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubEnterpriseRepository>()),
  getEnterpriseGitHubRepoSlug: getEnterpriseGitHubRepoSlugMock,
  isGitHubHostAuthenticated: isGitHubHostAuthenticatedMock
}))

import {
  _resetOriginGitHubApiRepositoryCache,
  getOriginGitHubApiRepository,
  githubHostExecOptions,
  resolveGitHubApiRepository,
  resolveGitHubRepoExecution
} from './github-api-repository'

beforeEach(() => {
  _resetOriginGitHubApiRepositoryCache()
  getEnterpriseGitHubRepoSlugMock.mockReset().mockResolvedValue(null)
  getOwnerRepoMock.mockReset().mockResolvedValue(null)
  getOwnerRepoForRemoteMock.mockReset().mockResolvedValue(null)
  isGitHubHostAuthenticatedMock.mockReset().mockResolvedValue(false)
})

describe('githubHostExecOptions', () => {
  it('pins every known repository host', () => {
    expect(githubHostExecOptions({ owner: 'acme', repo: 'widgets', host: 'github.com' })).toEqual({
      host: 'github.com'
    })
    expect(
      githubHostExecOptions({ owner: 'acme', repo: 'widgets', host: 'github.acme-corp.com' })
    ).toEqual({ host: 'github.acme-corp.com' })
  })

  it('does not invent a host when repository identity is unavailable or legacy', () => {
    expect(githubHostExecOptions({ owner: 'acme', repo: 'widgets' })).toEqual({})
    expect(githubHostExecOptions(null)).toEqual({})
  })
})

describe('resolveGitHubRepoExecution', () => {
  it('combines local repository and GitHub host execution options', async () => {
    const ownerRepo = { owner: 'acme', repo: 'widgets', host: 'github.acme-corp.com:8443' }
    isGitHubHostAuthenticatedMock.mockResolvedValue(true)

    await expect(
      resolveGitHubRepoExecution('/repo', ownerRepo, null, { wslDistro: 'Ubuntu' })
    ).resolves.toEqual({
      ownerRepo,
      ghOptions: {
        cwd: '/repo',
        wslDistro: 'Ubuntu',
        host: 'github.acme-corp.com:8443'
      }
    })
    expect(isGitHubHostAuthenticatedMock).toHaveBeenCalledWith(
      'github.acme-corp.com:8443',
      '/repo',
      null,
      { wslDistro: 'Ubuntu' }
    )
  })

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

  it('normalizes github.com without spending an auth inventory probe', async () => {
    await expect(
      resolveGitHubApiRepository('/repo', {
        owner: 'acme',
        repo: 'widgets',
        host: ' GitHub.COM '
      })
    ).resolves.toEqual({ owner: 'acme', repo: 'widgets', host: 'github.com' })

    expect(isGitHubHostAuthenticatedMock).not.toHaveBeenCalled()
  })

  it('backfills the origin host for a host-less caller-specific resolver', async () => {
    const ownerRepo = { owner: 'upstream', repo: 'widgets' }
    getOwnerRepoForRemoteMock.mockResolvedValue({ owner: 'fork', repo: 'widgets' })

    await expect(resolveGitHubRepoExecution('/repo', async () => ownerRepo)).resolves.toEqual({
      ownerRepo: { ...ownerRepo, host: 'github.com' },
      ghOptions: { cwd: '/repo', host: 'github.com' }
    })
  })

  it('backfills an Enterprise origin host for a host-less caller-specific resolver', async () => {
    const ownerRepo = { owner: 'upstream', repo: 'widgets' }
    getEnterpriseGitHubRepoSlugMock.mockResolvedValue({
      owner: 'fork',
      repo: 'widgets',
      host: 'github.acme-corp.com'
    })

    await expect(resolveGitHubRepoExecution('/repo', async () => ownerRepo)).resolves.toEqual({
      ownerRepo: { ...ownerRepo, host: 'github.acme-corp.com' },
      ghOptions: { cwd: '/repo', host: 'github.acme-corp.com' }
    })
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

  it('rejects a host-less caller-specific resolver for an unresolved local repository', async () => {
    await expect(
      resolveGitHubRepoExecution('/repo', async () => ({ owner: 'upstream', repo: 'widgets' }))
    ).resolves.toEqual({ ownerRepo: null, ghOptions: { cwd: '/repo' } })
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
  it('does not cache an indeterminate Enterprise auth probe', async () => {
    const enterprise = {
      owner: 'acme',
      repo: 'widgets',
      host: 'github.acme-corp.com'
    }
    getEnterpriseGitHubRepoSlugMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(enterprise)

    await expect(getOriginGitHubApiRepository('/repo')).resolves.toBeNull()
    await expect(getOriginGitHubApiRepository('/repo')).resolves.toEqual(enterprise)
    expect(getEnterpriseGitHubRepoSlugMock).toHaveBeenCalledTimes(2)
  })

  it('still caches a definitive negative Enterprise probe', async () => {
    await expect(getOriginGitHubApiRepository('/repo')).resolves.toBeNull()
    await expect(getOriginGitHubApiRepository('/repo')).resolves.toBeNull()
    expect(getEnterpriseGitHubRepoSlugMock).toHaveBeenCalledTimes(1)
  })
})
