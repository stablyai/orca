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
  readLocalGitConfigSignatureMock: Mock
  acquireMock: Mock
  releaseMock: Mock
}

// Vitest hoists per file; suites register these shared factories locally.
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
  const ghExecFileAsync = vi.fn(async (...args: unknown[]) => {
    const result = await mocks.ghExecFileAsyncMock(...args)
    const argv = args[0]
    // Domain fixtures supply JSON bodies; --include also emits the CLI's HTTP framing.
    if (
      Array.isArray(argv) &&
      argv.includes('--include') &&
      typeof argv[1] === 'string' &&
      /^repos\/[^/]+\/[^/]+\/pulls(?:\?head=|\/\d+$)/.test(argv[1]) &&
      typeof result?.stdout === 'string' &&
      !result.stdout.startsWith('HTTP/')
    ) {
      return { ...result, stdout: `HTTP/2.0 200 OK\n\n${result.stdout}` }
    }
    return result
  })
  return {
    execFileAsync: mocks.execFileAsyncMock,
    ghExecFileAsync,
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

export type LocalGitObjectQuarantineModuleMock = {
  createLocalGitObjectQuarantine: () => {
    run: <T>(command: (env: undefined) => Promise<T>) => Promise<T>
  }
}

// Isolate scripted Git queues from quarantine's additional common-dir probe.
export function localGitObjectQuarantineModuleMock(): LocalGitObjectQuarantineModuleMock {
  return {
    createLocalGitObjectQuarantine: () => ({ run: (command) => command(undefined) })
  }
}

export type LocalGitConfigSignatureModuleMock = {
  readLocalGitConfigSignature: Mock
}

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
    // Keep repository guards on the same bucket fixtures as the legacy entry points.
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
    // Resolve hosted seams through the suite's repository fixtures, avoiding real Enterprise probes.
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
      // Prefer explicit-origin fixtures; older suites define only getOwnerRepo.
      const fromRemote = await mocks.getOwnerRepoForRemoteMock(
        repoPath,
        'origin',
        connectionId,
        localGitOptions
      )
      const slug =
        fromRemote ?? (await mocks.getOwnerRepoMock(repoPath, connectionId, localGitOptions))
      return slug ? { host: 'github.com', ...slug } : slug
    },
    getIssueGitHubApiRepository: async (repoPath: string, connectionId?: string | null) => {
      const slug = await mocks.getIssueOwnerRepoMock(repoPath, connectionId)
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
