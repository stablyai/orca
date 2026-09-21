import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as GithubApiRepositoryModule from './github-api-repository'
import type * as GitHubEnterpriseRepositoryModule from './github-enterprise-repository'

const { clientMocks, moduleMocks } = await vi.hoisted(async () => {
  const moduleMocks = await import('./client-test-mocks')
  return { clientMocks: moduleMocks.createGitHubClientMocks(), moduleMocks }
})

vi.mock('./gh-utils', () => moduleMocks.ghUtilsModuleMock(clientMocks))
vi.mock('../git/runner', () => moduleMocks.gitRunnerModuleMock(clientMocks))
vi.mock('../providers/ssh-git-dispatch', () => moduleMocks.sshGitDispatchModuleMock(clientMocks))
vi.mock('./local-git-config-signature', () =>
  moduleMocks.localGitConfigSignatureModuleMock(clientMocks)
)
vi.mock('./github-enterprise-repository', async (importOriginal) =>
  moduleMocks.githubEnterpriseRepositoryModuleMock(
    await importOriginal<typeof GitHubEnterpriseRepositoryModule>()
  )
)
vi.mock('./rate-limit', () => moduleMocks.rateLimitModuleMock(clientMocks))
vi.mock('./github-api-repository', async (importOriginal) =>
  moduleMocks.githubApiRepositoryModuleMock(
    clientMocks,
    await importOriginal<typeof GithubApiRepositoryModule>()
  )
)

import { getGitHubPRLookupRateLimitBlock, _resetOwnerRepoCache } from './client'
import { resetOriginRepositoryCache } from './client-test-harness'
import type { RateLimitGuardResult } from './client-test-mocks'

const {
  execFileAsyncMock,
  ghExecFileAsyncMock,
  getOwnerRepoMock,
  getRemoteUrlForRepoMock,
  gitExecFileAsyncMock,
  getRateLimitMock,
  rateLimitGuardMock,
  noteRateLimitSpendMock
} = clientMocks

describe('getGitHubPRLookupRateLimitBlock', () => {
  beforeEach(() => {
    resetOriginRepositoryCache()
    execFileAsyncMock.mockReset()
    ghExecFileAsyncMock.mockReset()
    getOwnerRepoMock.mockReset()
    getOwnerRepoMock.mockResolvedValue({ owner: 'acme', repo: 'widgets' })
    getRemoteUrlForRepoMock.mockReset()
    gitExecFileAsyncMock.mockReset()
    getRateLimitMock.mockReset()
    getRateLimitMock.mockResolvedValue(undefined)
    rateLimitGuardMock.mockReset()
    rateLimitGuardMock.mockReturnValue({ blocked: false })
    noteRateLimitSpendMock.mockReset()
    _resetOwnerRepoCache()
  })

  it('reports no block while every lookup bucket has budget', async () => {
    await expect(getGitHubPRLookupRateLimitBlock('/repo-root')).resolves.toBeNull()
    expect(getRateLimitMock).toHaveBeenCalled()
  })

  it('reports a block when either lookup bucket is exhausted', async () => {
    rateLimitGuardMock.mockImplementation(((bucket: string) =>
      bucket === 'graphql'
        ? { blocked: true, remaining: 4, limit: 5000, resetAt: 1_800_000_000 }
        : { blocked: false }) as () => RateLimitGuardResult)

    await expect(getGitHubPRLookupRateLimitBlock('/repo-root')).resolves.toEqual({
      resetAt: 1_800_000_000
    })
  })

  it('reports the latest reset when both lookup buckets are exhausted', async () => {
    rateLimitGuardMock.mockImplementation(((bucket: string) => ({
      blocked: true,
      remaining: 4,
      limit: 5000,
      // Why: core resets first, so returning it would retry into graphql's block.
      resetAt: bucket === 'core' ? 1_800_000_000 : 1_800_003_600
    })) as () => RateLimitGuardResult)

    await expect(getGitHubPRLookupRateLimitBlock('/repo-root')).resolves.toEqual({
      resetAt: 1_800_003_600
    })
  })

  it('reports the later reset when graphql outlasts core', async () => {
    // Retrying at the earlier reset would fail again on the bucket still blocked.
    rateLimitGuardMock.mockImplementation(((bucket: string) => ({
      blocked: true,
      remaining: 0,
      limit: 5000,
      resetAt: bucket === 'graphql' ? 1_800_000_600 : 1_800_000_000
    })) as () => RateLimitGuardResult)

    await expect(getGitHubPRLookupRateLimitBlock('/repo-root')).resolves.toEqual({
      resetAt: 1_800_000_600
    })
  })

  it('fails open when the exempt rate-limit probe itself fails', async () => {
    getRateLimitMock.mockRejectedValue(new Error('probe offline'))

    await expect(getGitHubPRLookupRateLimitBlock('/repo-root')).resolves.toBeNull()
  })
})
