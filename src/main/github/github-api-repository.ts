import type { GitHubOwnerRepo } from '../../shared/github/pull-request-types'
import type { IssueSourcePreference } from '../../shared/repo-types'
import {
  githubRepoIdentityKey,
  isDefaultGitHubHost
} from '../../shared/github/repository-identity-key'
import {
  getOwnerRepoForRemote,
  ghRepoExecOptions,
  githubRepoContext,
  type GitHubRemoteIdentityProbeOptions,
  type LocalGitExecOptions
} from './gh-utils'
import {
  getEnterpriseGitHubRepoSlug,
  getEnterpriseGitHubRepoSlugForRemote,
  isGitHubHostAuthenticated
} from './github-enterprise-repository'
import { githubHostExecOptions } from './github-repository-host'
import {
  isValidGitHubApiRepository,
  type GitHubApiRepositoryResolution
} from './github-api-repository-validation'
import {
  githubApiRepositoryProbeCacheKey,
  resolveGitHubApiRepositoryProbe
} from './github-api-repository-probe'
import { resolveBranchHeadRepository } from './github-branch-head-remote'

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

// Why: cache the uncached Enterprise remote probe used by hot paths.
const ORIGIN_REPO_CACHE_TTL_MS = 30_000
const ORIGIN_REPO_CACHE_MAX_ENTRIES = 512
const originRepoCache = new Map<string, { value: GitHubApiRepository | null; expiresAt: number }>()
const originRepoInFlight = new Map<string, Promise<GitHubApiRepository | null>>()

/** @internal - exposed for tests only */
export function _resetOriginGitHubApiRepositoryCache(): void {
  originRepoCache.clear()
  originRepoInFlight.clear()
}

function pruneOriginRepoCache(now: number): void {
  for (const [key, entry] of originRepoCache) {
    if (entry.expiresAt <= now) {
      originRepoCache.delete(key)
    }
  }
  while (originRepoCache.size > ORIGIN_REPO_CACHE_MAX_ENTRIES) {
    const oldestKey = originRepoCache.keys().next().value
    if (oldestKey === undefined) {
      return
    }
    originRepoCache.delete(oldestKey)
  }
}

/**
 * Host-qualified repository identity for one remote: github.com remotes come
 * from the cached slug parser; any other GitHub-shaped host is auth-gated so a
 * non-GitHub forge never routes to the GitHub provider.
 */
export async function getGitHubApiRepositoryForRemote(
  repoPath: string,
  remoteName: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {},
  probeOptions: GitHubRemoteIdentityProbeOptions = {}
): Promise<GitHubApiRepository | null> {
  // Why: generic PR resolution prefers upstream, but this API represents the
  // caller-selected remote exactly (#7331).
  const requireVerifiedSshProbe = probeOptions.requireVerifiedSshProbe === true
  const verifiedIdentityArgs = requireVerifiedSshProbe ? ([probeOptions] as const) : []
  const ownerRepo = await getOwnerRepoForRemote(
    repoPath,
    remoteName,
    connectionId,
    localGitOptions,
    ...verifiedIdentityArgs
  )
  if (ownerRepo) {
    return { ...ownerRepo, host: 'github.com' }
  }
  const cacheKey = githubApiRepositoryProbeCacheKey(
    repoPath,
    remoteName,
    connectionId,
    localGitOptions,
    requireVerifiedSshProbe
  )
  const now = Date.now()
  pruneOriginRepoCache(now)
  const cached = originRepoCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    return cached.value
  }
  const inFlight = originRepoInFlight.get(cacheKey)
  if (inFlight) {
    return inFlight
  }
  const probe = (async () => {
    const enterpriseOptions =
      Object.keys(localGitOptions).length > 0 ? { localGitExecOptions: localGitOptions } : {}
    const verifiedEnterpriseArgs = requireVerifiedSshProbe ? ([true] as const) : []
    const slug =
      remoteName === 'origin'
        ? await getEnterpriseGitHubRepoSlug(
            repoPath,
            connectionId,
            enterpriseOptions,
            ...verifiedEnterpriseArgs
          )
        : await getEnterpriseGitHubRepoSlugForRemote(
            repoPath,
            remoteName,
            connectionId,
            enterpriseOptions,
            ...verifiedEnterpriseArgs
          )
    // Why: undefined means the gh auth inventory could not be read. Caching it
    // as a negative would turn a transient spawn failure into a 30-second miss.
    if (slug !== undefined) {
      originRepoCache.set(cacheKey, {
        value: slug,
        expiresAt: Date.now() + ORIGIN_REPO_CACHE_TTL_MS
      })
      pruneOriginRepoCache(Date.now())
    }
    return resolveGitHubApiRepositoryProbe(slug, requireVerifiedSshProbe)
  })()
  originRepoInFlight.set(cacheKey, probe)
  try {
    return await probe
  } finally {
    if (originRepoInFlight.get(cacheKey) === probe) {
      originRepoInFlight.delete(cacheKey)
    }
  }
}

export async function getOriginGitHubApiRepository(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitHubApiRepository | null> {
  return getGitHubApiRepositoryForRemote(repoPath, 'origin', connectionId, localGitOptions)
}

/** Hosted mirror of getIssueOwnerRepo: issues prefer `upstream` over `origin`. */
export async function getIssueGitHubApiRepository(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitHubApiRepository | null> {
  const upstream = await getGitHubApiRepositoryForRemote(
    repoPath,
    'upstream',
    connectionId,
    localGitOptions
  )
  if (upstream) {
    return upstream
  }
  return getGitHubApiRepositoryForRemote(repoPath, 'origin', connectionId, localGitOptions)
}

export type GitHubApiRepositoryCandidates = {
  candidates: GitHubApiRepository[]
  headRepo: GitHubApiRepository | null
}

/**
 * Hosted mirror of resolvePRRepositoryCandidates: upstream first, then origin.
 *
 * `headRepo` names the repository whose branch a pull request would be opened
 * from. With `branchName` supplied it is resolved from the remote that actually
 * holds the branch, so a cross-fork head is filtered on the fork's owner rather
 * than the canonical repo's (#12956); it is null when no single remote can be
 * identified, which routes the caller to the head-owner-agnostic lookup that
 * resolves cross-fork heads on its own. Without `branchName` it stays `origin`,
 * preserving every caller that is not doing a branch lookup.
 */
export async function resolveGitHubApiRepositoryCandidates(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {},
  branchName?: string | null
): Promise<GitHubApiRepositoryCandidates> {
  const [upstream, origin] = await Promise.all([
    getGitHubApiRepositoryForRemote(repoPath, 'upstream', connectionId, localGitOptions, {
      requireVerifiedSshProbe: true
    }),
    getGitHubApiRepositoryForRemote(repoPath, 'origin', connectionId, localGitOptions, {
      requireVerifiedSshProbe: true
    })
  ])
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
  const headRepo = branchName
    ? await resolveBranchHeadRepository(
        { repoPath, branchName, connectionId, localGitOptions },
        (remote) => getGitHubApiRepositoryForRemote(repoPath, remote, connectionId, localGitOptions)
      )
    : origin
  return { candidates, headRepo }
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
