import { withGitHubRepoExecution } from './github-repository-identity'
import type { GitHubOwnerRepo } from '../../shared/github/pull-request-types'
import type { IssueSourcePreference } from '../../shared/repo-types'
import {
  githubRepoIdentityKey,
  isDefaultGitHubHost
} from '../../shared/github/repository-identity-key'
import { shouldProbeGitRemote } from '../git/remote-name-listing'
import { ghRepoExecOptions, githubRepoContext, type LocalGitExecOptions } from './gh-utils'
import { isGitHubHostAuthenticated } from './github-enterprise-repository'
import { githubHostExecOptions } from './github-repository-host'
import {
  isValidGitHubApiRepository,
  type GitHubApiRepositoryResolution
} from './github-api-repository-validation'
import {
  _resetOriginGitHubApiRepositoryCache,
  getGitHubApiRepositoryForRemote,
  getOriginGitHubApiRepository
} from './github-api-repository-remote-probe'

export {
  githubHostExecOptions,
  githubRepositorySlugArg,
  githubRepositoryWebHost
} from './github-repository-host'
export type GitHubApiRepository = GitHubOwnerRepo
export type GitHubRepoExecOptions = ReturnType<typeof ghRepoExecOptions> & {
  host?: string
  env?: NodeJS.ProcessEnv
}
export type GitHubRepoExecution = {
  ownerRepo: GitHubApiRepository | null
  ghOptions: GitHubRepoExecOptions
}
export {
  _resetOriginGitHubApiRepositoryCache,
  getGitHubApiRepositoryForRemote,
  getOriginGitHubApiRepository
}

/** Hosted mirror of getIssueOwnerRepo: issues prefer `upstream` over `origin`. */
export async function getIssueGitHubApiRepository(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitHubApiRepository | null> {
  return withGitHubRepoExecution(repoPath, connectionId, localGitOptions, async () => {
    const originPromise = getGitHubApiRepositoryForRemote(
      repoPath,
      'origin',
      connectionId,
      localGitOptions
    ).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason })
    )
    const upstream = (await shouldProbeGitRemote(
      repoPath,
      'upstream',
      connectionId,
      localGitOptions
    ))
      ? await getGitHubApiRepositoryForRemote(repoPath, 'upstream', connectionId, localGitOptions)
      : null
    if (upstream) {
      return upstream
    }
    const origin = await originPromise
    if (origin.status === 'rejected') {
      throw origin.reason
    }
    return origin.value
  })
}

export type GitHubApiRepositoryCandidates = {
  candidates: GitHubApiRepository[]
  headRepo: GitHubApiRepository | null
}

/** Hosted mirror of resolvePRRepositoryCandidates: upstream first, then origin. */
export async function resolveGitHubApiRepositoryCandidates(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitHubApiRepositoryCandidates> {
  return withGitHubRepoExecution(repoPath, connectionId, localGitOptions, async () => {
    const originPromise = getGitHubApiRepositoryForRemote(
      repoPath,
      'origin',
      connectionId,
      localGitOptions,
      {
        requireVerifiedSshProbe: true
      }
    ).then(
      (value) => ({ status: 'fulfilled' as const, value }),
      (reason: unknown) => ({ status: 'rejected' as const, reason })
    )
    const probeUpstream = await shouldProbeGitRemote(
      repoPath,
      'upstream',
      connectionId,
      localGitOptions
    )
    const [upstream, originResult] = await Promise.all([
      probeUpstream
        ? getGitHubApiRepositoryForRemote(repoPath, 'upstream', connectionId, localGitOptions, {
            requireVerifiedSshProbe: true
          })
        : null,
      originPromise
    ])
    if (originResult.status === 'rejected') {
      throw originResult.reason
    }
    const origin = originResult.value
    const seen = new Set<string>()
    const candidates: GitHubApiRepository[] = []
    for (const candidate of [upstream, origin]) {
      if (!candidate) {
        continue
      }
      const key = githubRepoIdentityKey(candidate)
      if (seen.has(key)) {
        continue
      }
      seen.add(key)
      candidates.push(candidate)
    }
    return { candidates, headRepo: origin }
  })
}

export type ResolvedGitHubApiRepositorySource = {
  source: GitHubApiRepository | null
  /** True when explicit upstream is gone and resolver fell back to origin. */
  fellBack: boolean
}

export async function resolveIssueGitHubApiRepositorySource(
  repoPath: string,
  preference: IssueSourcePreference | undefined,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<ResolvedGitHubApiRepositorySource> {
  return withGitHubRepoExecution(repoPath, connectionId, localGitOptions, async () => {
    if (preference === 'upstream') {
      const upstream = await getGitHubApiRepositoryForRemote(
        repoPath,
        'upstream',
        connectionId,
        localGitOptions
      )
      if (upstream) {
        return { source: upstream, fellBack: false }
      }
      const origin = await getGitHubApiRepositoryForRemote(
        repoPath,
        'origin',
        connectionId,
        localGitOptions
      )
      return { source: origin, fellBack: origin !== null }
    }
    if (preference === 'origin') {
      return {
        source: await getGitHubApiRepositoryForRemote(
          repoPath,
          'origin',
          connectionId,
          localGitOptions
        ),
        fellBack: false
      }
    }
    return {
      source: await getIssueGitHubApiRepository(repoPath, connectionId, localGitOptions),
      fellBack: false
    }
  })
}

export async function resolveGitHubApiRepository(
  repoPath: string,
  repository?: GitHubApiRepository | null,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitHubApiRepository | null> {
  return withGitHubRepoExecution(repoPath, connectionId, localGitOptions, async () => {
    if (repository && !isValidGitHubApiRepository(repository)) {
      return null
    }
    if (repository?.host) {
      const host = repository.host.trim().toLowerCase()
      if (!host) {
        return null
      }
      if (isDefaultGitHubHost(host)) {
        return { ...repository, host }
      }
      // Verify supplied hosts against local auth inventory before giving them ambient Enterprise credentials.
      const authenticated = await isGitHubHostAuthenticated(
        host,
        repoPath,
        connectionId,
        localGitOptions
      )
      return authenticated ? { ...repository, host } : null
    }
    const originRepository = await getOriginGitHubApiRepository(
      repoPath,
      connectionId,
      localGitOptions
    )
    if (!repository) {
      return originRepository
    }
    // Older clients omit host; resolved origin supplies it for fork-base slugs on the same server.
    if (originRepository?.host) {
      return { ...repository, host: originRepository.host }
    }
    // Host-less calls could follow ambient GH_HOST; only resolved origin can supply the legacy host.
    return null
  })
}

export async function resolveGitHubRepoExecution(
  repoPath: string,
  repository?: GitHubApiRepositoryResolution,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitHubRepoExecution> {
  return withGitHubRepoExecution(repoPath, connectionId, localGitOptions, async () => {
    // Retain upstream-first issue resolution with the same host-pinned execution options.
    const requestedRepository = typeof repository === 'function' ? await repository() : repository
    // Preserve authoritative nulls instead of replacing them with origin.
    const ownerRepo =
      typeof repository === 'function' && !requestedRepository
        ? null
        : await resolveGitHubApiRepository(
            repoPath,
            requestedRepository,
            connectionId,
            localGitOptions
          )
    return {
      ownerRepo,
      ghOptions: {
        ...ghRepoExecOptions(githubRepoContext(repoPath, connectionId, localGitOptions)),
        ...githubHostExecOptions(ownerRepo)
      }
    }
  })
}
