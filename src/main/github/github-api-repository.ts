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
export type GitHubRepoExecOptions = ReturnType<typeof ghRepoExecOptions> & { host?: string }
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
  const originPromise = getGitHubApiRepositoryForRemote(
    repoPath,
    'origin',
    connectionId,
    localGitOptions
  ).then(
    (value) => ({ status: 'fulfilled' as const, value }),
    (reason: unknown) => ({ status: 'rejected' as const, reason })
  )
  const upstream = (await shouldProbeGitRemote(repoPath, 'upstream', connectionId, localGitOptions))
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
}

export type ResolvedGitHubApiRepositorySource = {
  source: GitHubApiRepository | null
  /** True when explicit upstream is gone and resolver fell back to origin. */
  fellBack: boolean
}

/** Hosted mirror of resolveIssueSource — same preference semantics. */
export async function resolveIssueGitHubApiRepositorySource(
  repoPath: string,
  preference: IssueSourcePreference | undefined,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<ResolvedGitHubApiRepositorySource> {
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
}

export async function resolveGitHubApiRepository(
  repoPath: string,
  repository?: GitHubApiRepository | null,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitHubApiRepository | null> {
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
    // Why: client-supplied hosts must match gh's local auth inventory before
    // they can receive ambient Enterprise credentials from a host-pinned call.
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
  // Why: older clients only send owner/repo. The origin still supplies the
  // execution host for fork-base slugs on the same GitHub Enterprise server.
  if (originRepository?.host) {
    return { ...repository, host: originRepository.host }
  }
  // Why: a host-less identity can honor ambient GH_HOST even with a local cwd.
  // Only a resolved origin may supply the execution host for legacy clients.
  return null
}

export async function resolveGitHubRepoExecution(
  repoPath: string,
  repository?: GitHubApiRepositoryResolution,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitHubRepoExecution> {
  // Why: issue-scoped paths retain their upstream-first resolver while sharing
  // the same repo-scoped and host-scoped gh execution option construction.
  const requestedRepository = typeof repository === 'function' ? await repository() : repository
  // Why: normalize host-less resolver results without replacing an
  // authoritative null with the generic origin fallback.
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
}
