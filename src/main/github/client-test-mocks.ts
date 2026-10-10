import { vi, type Mock } from 'vitest'
import type { ClassifiedError } from '../../shared/classified-error'
import type { GitHubOwnerRepo } from '../../shared/github/pull-request-types'
import type * as GithubApiRepositoryModule from './github-api-repository'
import type * as GitHubEnterpriseRepositoryModule from './github-enterprise-repository'
import type { ghRepoExecOptions, githubRepoContext } from './github-repository-identity'

export type RateLimitGuardResult =
  | { blocked: false }
  | { blocked: true; remaining: number; limit: number; resetAt: number }

export type GitHubClientMocks = {
  execFileAsyncMock: Mock
  ghExecFileAsyncMock: Mock
  getOwnerRepoMock: Mock
  getIssueOwnerRepoMock: Mock
  getOwnerRepoForRemoteMock: Mock
  resolvePRRepositoryCandidatesMock: Mock
  getRemoteUrlForRepoMock: Mock
  gitExecFileAsyncMock: Mock
  getRateLimitMock: Mock
  rateLimitGuardMock: Mock<(bucket?: string) => RateLimitGuardResult>
  noteRateLimitSpendMock: Mock
  ghRepoExecOptionsMock: Mock<typeof ghRepoExecOptions>
  githubRepoContextMock: Mock<typeof githubRepoContext>
  getSshGitProviderMock: Mock
  readLocalGitConfigSignatureMock: Mock
  acquireMock: Mock
  releaseMock: Mock
}

// Why: every client suite registers its own `vi.mock` factories (hoisting is
// per-file), so the mock set and the factory bodies live here and the test file
// only wires them together.
export function createGitHubClientMocks(): GitHubClientMocks {
  return {
    execFileAsyncMock: vi.fn(),
    ghExecFileAsyncMock: vi.fn(),
    getOwnerRepoMock: vi.fn(),
    getIssueOwnerRepoMock: vi.fn(),
    getOwnerRepoForRemoteMock: vi.fn(),
    resolvePRRepositoryCandidatesMock: vi.fn(),
    getRemoteUrlForRepoMock: vi.fn(),
    gitExecFileAsyncMock: vi.fn(),
    getRateLimitMock: vi.fn(),
    rateLimitGuardMock: vi.fn<(bucket?: string) => RateLimitGuardResult>(() => ({
      blocked: false
    })),
    noteRateLimitSpendMock: vi.fn(),
    ghRepoExecOptionsMock: vi.fn<typeof ghRepoExecOptions>((context) =>
      context.connectionId
        ? {}
        : {
            cwd: context.repoPath,
            ...(context.wslDistro ? { wslDistro: context.wslDistro } : {})
          }
    ),
    githubRepoContextMock: vi.fn<typeof githubRepoContext>(
      (repoPath, connectionId, localGitOptions) => ({
        repoPath,
        connectionId: connectionId ?? null,
        ...localGitOptions
      })
    ),
    getSshGitProviderMock: vi.fn(),
    readLocalGitConfigSignatureMock: vi.fn(),
    acquireMock: vi.fn(),
    releaseMock: vi.fn()
  }
}

export type GhUtilsModuleMock = {
  execFileAsync: Mock
  ghExecFileAsync: Mock
  getOwnerRepo: Mock
  getIssueOwnerRepo: Mock
  getOwnerRepoForRemote: Mock
  resolvePRRepositoryCandidates: Mock
  getRemoteUrlForRepo: Mock
  gitExecFileAsync: Mock
  ghRepoExecOptions: Mock<typeof ghRepoExecOptions>
  githubRepoContext: Mock<typeof githubRepoContext>
  classifyGhError: (stderr: string) => ClassifiedError
  parseGitHubOwnerRepo: (remoteUrl: string) => GitHubOwnerRepo | null
  acquire: Mock
  release: Mock
  _resetOwnerRepoCache: Mock
}

export function ghUtilsModuleMock(mocks: GitHubClientMocks): GhUtilsModuleMock {
  return {
    execFileAsync: mocks.execFileAsyncMock,
    ghExecFileAsync: mocks.ghExecFileAsyncMock,
    getOwnerRepo: mocks.getOwnerRepoMock,
    getIssueOwnerRepo: mocks.getIssueOwnerRepoMock,
    getOwnerRepoForRemote: mocks.getOwnerRepoForRemoteMock,
    resolvePRRepositoryCandidates: mocks.resolvePRRepositoryCandidatesMock,
    getRemoteUrlForRepo: mocks.getRemoteUrlForRepoMock,
    gitExecFileAsync: mocks.gitExecFileAsyncMock,
    ghRepoExecOptions: mocks.ghRepoExecOptionsMock,
    githubRepoContext: mocks.githubRepoContextMock,
    classifyGhError: (stderr: string) => {
      const lower = stderr.toLowerCase()
      if (lower.includes('not found') || stderr.includes('HTTP 404')) {
        return { type: 'not_found', message: stderr }
      }
      if (lower.includes('rate limit')) {
        return { type: 'rate_limited', message: stderr }
      }
      if (lower.includes('resource not accessible')) {
        return { type: 'permission_denied', message: stderr }
      }
      return { type: 'unknown', message: stderr }
    },
    parseGitHubOwnerRepo: (remoteUrl: string) => {
      const match = remoteUrl.trim().match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/)
      return match ? { owner: match[1], repo: match[2] } : null
    },
    acquire: mocks.acquireMock,
    release: mocks.releaseMock,
    _resetOwnerRepoCache: vi.fn()
  }
}

export type GitRunnerModuleMock = { gitExecFileAsync: Mock; ghExecFileAsync: Mock }

export function gitRunnerModuleMock(mocks: GitHubClientMocks): GitRunnerModuleMock {
  return {
    gitExecFileAsync: mocks.gitExecFileAsyncMock,
    ghExecFileAsync: mocks.ghExecFileAsyncMock
  }
}

export type SshGitDispatchModuleMock = {
  getSshGitProviderGeneration: Mock
  getSshGitProvider: Mock
  SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE: string
}

export function sshGitDispatchModuleMock(mocks: GitHubClientMocks): SshGitDispatchModuleMock {
  return {
    getSshGitProviderGeneration: vi.fn(() => 0),
    getSshGitProvider: mocks.getSshGitProviderMock,
    SSH_GIT_PROVIDER_UNAVAILABLE_MESSAGE: 'Remote connection dropped.'
  }
}

export type LocalGitConfigSignatureModuleMock = { readLocalGitConfigSignature: Mock }

export function localGitConfigSignatureModuleMock(
  mocks: GitHubClientMocks
): LocalGitConfigSignatureModuleMock {
  return { readLocalGitConfigSignature: mocks.readLocalGitConfigSignatureMock }
}

export function githubEnterpriseRepositoryModuleMock(
  actual: typeof GitHubEnterpriseRepositoryModule
): typeof GitHubEnterpriseRepositoryModule {
  return {
    ...actual,
    isGitHubHostAuthenticated: vi.fn().mockResolvedValue(true)
  }
}

export type RateLimitModuleMock = {
  getRateLimit: Mock
  rateLimitGuard: Mock<(bucket?: string) => RateLimitGuardResult>
  noteRateLimitSpend: Mock
  repositoryRateLimitGuard: (repository: unknown, bucket: string) => RateLimitGuardResult
  noteRepositoryRateLimitSpend: (repository: unknown, bucket: string) => void
  spendsSharedGitHubComQuota: () => boolean
}

export function rateLimitModuleMock(mocks: GitHubClientMocks): RateLimitModuleMock {
  return {
    getRateLimit: mocks.getRateLimitMock,
    rateLimitGuard: mocks.rateLimitGuardMock,
    noteRateLimitSpend: mocks.noteRateLimitSpendMock,
    // Why: the repository-scoped guards share the same bucket-keyed budget as the
    // legacy ones, so delegate to the existing mocks to keep per-bucket blocking
    // and spend assertions working unchanged.
    repositoryRateLimitGuard: (_repository: unknown, bucket: string) =>
      mocks.rateLimitGuardMock(bucket),
    noteRepositoryRateLimitSpend: (_repository: unknown, bucket: string) =>
      mocks.noteRateLimitSpendMock(bucket),
    spendsSharedGitHubComQuota: () => true
  }
}

export function githubApiRepositoryModuleMock(
  mocks: GitHubClientMocks,
  actual: typeof GithubApiRepositoryModule
): typeof GithubApiRepositoryModule {
  return {
    ...actual,
    // Why: these suites inject repo identities through the legacy gh-utils
    // mocks; bridge the hosted seams onto the same mocks so per-test setups
    // keep driving resolution without real enterprise probes.
    resolveGitHubApiRepositoryCandidates: (
      repoPath: string,
      connectionId?: string | null,
      localGitOptions?: unknown
    ) => mocks.resolvePRRepositoryCandidatesMock(repoPath, connectionId, localGitOptions),
    getGitHubApiRepositoryForRemote: (
      repoPath: string,
      remoteName: string,
      connectionId?: string | null
    ) => mocks.getOwnerRepoForRemoteMock(repoPath, remoteName, connectionId),
    getOriginGitHubApiRepository: async (
      repoPath: string,
      connectionId?: string | null,
      localGitOptions?: unknown
    ) => {
      // Prefer the remote-specific mock (production origin path); fall back for
      // suites that only configure getOwnerRepo.
      const fromRemote = await mocks.getOwnerRepoForRemoteMock(
        repoPath,
        'origin',
        connectionId,
        localGitOptions
      )
      const slug =
        fromRemote ?? (await mocks.getOwnerRepoMock(repoPath, connectionId, localGitOptions))
      // Mirror production: dotcom origin slugs come back pinned to github.com.
      return slug ? { host: 'github.com', ...slug } : slug
    },
    getIssueGitHubApiRepository: async (repoPath: string, connectionId?: string | null) => {
      const slug = await mocks.getIssueOwnerRepoMock(repoPath, connectionId)
      // Mirror production: issue slugs come back host-qualified to github.com.
      return slug ? { host: 'github.com', ...slug } : slug
    },
    resolveIssueGitHubApiRepositorySource: async (
      repoPath: string,
      _preference: unknown,
      connectionId?: string | null
    ) => {
      const slug = await mocks.getIssueOwnerRepoMock(repoPath, connectionId)
      return { source: slug ? { host: 'github.com', ...slug } : slug, fellBack: false }
    }
  }
}
