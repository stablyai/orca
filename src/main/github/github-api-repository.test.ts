import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as SshGitDispatch from '../providers/ssh-git-dispatch'
import type * as GitHubEnterpriseRepository from './github-enterprise-repository'
import type * as GhUtils from './gh-utils'

const {
  getEnterpriseGitHubRepoSlugMock,
  getOwnerRepoMock,
  getOwnerRepoForRemoteMock,
  getSshGitProviderGenerationMock,
  isGitHubHostAuthenticatedMock,
  resolveBranchHeadRemoteNameMock
} = vi.hoisted(() => ({
  getEnterpriseGitHubRepoSlugMock: vi.fn(),
  getOwnerRepoMock: vi.fn(),
  getOwnerRepoForRemoteMock: vi.fn(),
  getSshGitProviderGenerationMock: vi.fn(() => 0),
  isGitHubHostAuthenticatedMock: vi.fn(),
  resolveBranchHeadRemoteNameMock: vi.fn()
}))

vi.mock('./github-branch-head-remote', () => ({
  // Keeps these tests expressed as "which remote holds the branch" while still
  // exercising the real injection contract.
  resolveBranchHeadRepository: async (
    query: { branchName: string },
    getRepositoryForRemote: (remoteName: string) => Promise<unknown>
  ) => {
    const remoteName = await resolveBranchHeadRemoteNameMock(query)
    return remoteName ? getRepositoryForRemote(remoteName) : null
  }
}))

vi.mock('../providers/ssh-git-dispatch', async (importOriginal) => ({
  ...(await importOriginal<typeof SshGitDispatch>()),
  getSshGitProviderGeneration: getSshGitProviderGenerationMock
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
  getGitHubApiRepositoryForRemote,
  getOriginGitHubApiRepository,
  githubHostExecOptions,
  resolveGitHubApiRepository,
  resolveGitHubApiRepositoryCandidates,
  resolveGitHubRepoExecution
} from './github-api-repository'

beforeEach(() => {
  _resetOriginGitHubApiRepositoryCache()
  getEnterpriseGitHubRepoSlugMock.mockReset().mockResolvedValue(null)
  getOwnerRepoMock.mockReset().mockResolvedValue(null)
  getOwnerRepoForRemoteMock.mockReset().mockResolvedValue(null)
  getSshGitProviderGenerationMock.mockReset().mockReturnValue(0)
  isGitHubHostAuthenticatedMock.mockReset().mockResolvedValue(false)
  resolveBranchHeadRemoteNameMock.mockReset().mockResolvedValue(null)
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
  it('isolates Enterprise identity across SSH provider generations', async () => {
    const beforeReconnect = { owner: 'acme', repo: 'widgets', host: 'github.acme-corp.com' }
    const afterReconnect = { owner: 'acme', repo: 'other', host: 'github.acme-corp.com' }
    getEnterpriseGitHubRepoSlugMock
      .mockResolvedValueOnce(beforeReconnect)
      .mockResolvedValueOnce(afterReconnect)

    await expect(getOriginGitHubApiRepository('/remote/repo', 'ssh-1')).resolves.toEqual(
      beforeReconnect
    )
    getSshGitProviderGenerationMock.mockReturnValue(1)
    await expect(getOriginGitHubApiRepository('/remote/repo', 'ssh-1')).resolves.toEqual(
      afterReconnect
    )
    expect(getEnterpriseGitHubRepoSlugMock).toHaveBeenCalledTimes(2)
  })

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

  it('does not reuse a cached answer after the SSH provider reconnects', async () => {
    const oldRepository = {
      owner: 'old-owner',
      repo: 'widgets',
      host: 'github.acme-corp.com'
    }
    const newRepository = {
      owner: 'new-owner',
      repo: 'widgets',
      host: 'github.acme-corp.com'
    }
    getSshGitProviderGenerationMock.mockReturnValue(1)
    getEnterpriseGitHubRepoSlugMock
      .mockResolvedValueOnce(oldRepository)
      .mockResolvedValueOnce(newRepository)

    await expect(getOriginGitHubApiRepository('/repo', 'ssh-1')).resolves.toEqual(oldRepository)
    await expect(getOriginGitHubApiRepository('/repo', 'ssh-1')).resolves.toEqual(oldRepository)
    expect(getEnterpriseGitHubRepoSlugMock).toHaveBeenCalledTimes(1)

    getSshGitProviderGenerationMock.mockReturnValue(2)
    await expect(getOriginGitHubApiRepository('/repo', 'ssh-1')).resolves.toEqual(newRepository)
    expect(getEnterpriseGitHubRepoSlugMock).toHaveBeenCalledTimes(2)
  })

  it('does not reuse a cached negative after the SSH provider reconnects', async () => {
    const repository = {
      owner: 'acme',
      repo: 'widgets',
      host: 'github.acme-corp.com'
    }
    getSshGitProviderGenerationMock.mockReturnValue(1)
    getEnterpriseGitHubRepoSlugMock.mockResolvedValueOnce(null).mockResolvedValueOnce(repository)

    await expect(getOriginGitHubApiRepository('/repo', 'ssh-1')).resolves.toBeNull()
    await expect(getOriginGitHubApiRepository('/repo', 'ssh-1')).resolves.toBeNull()
    expect(getEnterpriseGitHubRepoSlugMock).toHaveBeenCalledTimes(1)

    getSshGitProviderGenerationMock.mockReturnValue(2)
    await expect(getOriginGitHubApiRepository('/repo', 'ssh-1')).resolves.toEqual(repository)
    expect(getEnterpriseGitHubRepoSlugMock).toHaveBeenCalledTimes(2)
  })

  it('isolates an in-flight probe from an older SSH provider generation', async () => {
    const oldRepository = {
      owner: 'old-owner',
      repo: 'widgets',
      host: 'github.acme-corp.com'
    }
    const newRepository = {
      owner: 'new-owner',
      repo: 'widgets',
      host: 'github.acme-corp.com'
    }
    let resolveOldProbe: (repository: typeof oldRepository) => void = () => {}
    const oldProbeResult = new Promise<typeof oldRepository>((resolve) => {
      resolveOldProbe = resolve
    })
    getEnterpriseGitHubRepoSlugMock
      .mockImplementationOnce(() => oldProbeResult)
      .mockResolvedValueOnce(newRepository)
    getSshGitProviderGenerationMock.mockReturnValue(1)

    const oldProbe = getOriginGitHubApiRepository('/repo', 'ssh-1')
    await vi.waitFor(() => expect(getEnterpriseGitHubRepoSlugMock).toHaveBeenCalledTimes(1))

    getSshGitProviderGenerationMock.mockReturnValue(2)
    const newProbe = getOriginGitHubApiRepository('/repo', 'ssh-1')
    await vi.waitFor(() => expect(getEnterpriseGitHubRepoSlugMock).toHaveBeenCalledTimes(2))
    await expect(newProbe).resolves.toEqual(newRepository)

    resolveOldProbe(oldRepository)
    await expect(oldProbe).resolves.toEqual(oldRepository)
    await expect(getOriginGitHubApiRepository('/repo', 'ssh-1')).resolves.toEqual(newRepository)
    expect(getEnterpriseGitHubRepoSlugMock).toHaveBeenCalledTimes(2)
  })
})

describe('resolveGitHubApiRepositoryCandidates head repository', () => {
  const CANONICAL = { owner: 'stablyai', repo: 'orca', host: 'github.com' }
  const FORK = { owner: 'dcieslak19973', repo: 'orca', host: 'github.com' }
  const BRANCH = 'dcieslak19973/feature'

  function stubRemotes(byRemote: Record<string, { owner: string; repo: string } | null>): void {
    getOwnerRepoForRemoteMock.mockImplementation(
      async (_path: string, remote: string) => byRemote[remote] ?? null
    )
  }

  // Why: every caller that is not doing a branch lookup keeps origin.
  it('keeps origin as the head repository when no branch is supplied', async () => {
    stubRemotes({ origin: CANONICAL })

    const { headRepo } = await resolveGitHubApiRepositoryCandidates('/repo')

    expect(headRepo).toEqual(CANONICAL)
    expect(resolveBranchHeadRemoteNameMock).not.toHaveBeenCalled()
  })

  // #12956: origin is the canonical repo and the branch lives on a
  // differently-named fork remote, so the head owner must be the fork's.
  it('uses the fork that holds the branch as the head repository', async () => {
    stubRemotes({ origin: CANONICAL, fork: FORK })
    resolveBranchHeadRemoteNameMock.mockResolvedValue('fork')

    const { candidates, headRepo } = await resolveGitHubApiRepositoryCandidates(
      '/repo',
      null,
      {},
      BRANCH
    )

    expect(headRepo).toEqual(FORK)
    // The query still runs against the canonical repo that owns the PR.
    expect(candidates).toEqual([CANONICAL])
  })

  it('leaves the head repository unset when no single remote holds the branch', async () => {
    stubRemotes({ origin: CANONICAL })
    resolveBranchHeadRemoteNameMock.mockResolvedValue(null)

    const { headRepo } = await resolveGitHubApiRepositoryCandidates('/repo', null, {}, BRANCH)

    // Null selects the head-owner-agnostic lookup instead of filtering on a guess.
    expect(headRepo).toBeNull()
  })

  it('leaves the head repository unset when the branch remote is not a GitHub repo', async () => {
    stubRemotes({ origin: CANONICAL, gitea: null })
    resolveBranchHeadRemoteNameMock.mockResolvedValue('gitea')

    const { headRepo } = await resolveGitHubApiRepositoryCandidates('/repo', null, {}, BRANCH)

    expect(headRepo).toBeNull()
  })
})
