import type { GitHubApiRepository } from './github-api-repository'
import { shouldProbeGitRemote } from '../git/remote-name-listing'
import {
  getOwnerRepoForRemote,
  type GitHubRemoteIdentityProbeOptions,
  type LocalGitExecOptions
} from './gh-utils'
import {
  getEnterpriseGitHubRepoSlug,
  getEnterpriseGitHubRepoSlugForRemote
} from './github-enterprise-repository'
import {
  githubApiRepositoryProbeCacheKey,
  resolveGitHubApiRepositoryProbe
} from './github-api-repository-probe'

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
  // Why: this is the lowest-level entry point every non-origin remote lookup
  // routes through (getRepoUpstream, tracked-upstream branch resolution,
  // explicit-upstream issue/PR preference), so gating here — rather than in
  // each caller — is what stops a remote git doesn't have (e.g. a removed
  // `upstream`, or a branch whose tracked remote is stale) from spawning a
  // `git remote get-url <name>` on every poll. `origin` is exempt: callers
  // depend on it being attempted unconditionally so a genuinely missing
  // origin still surfaces as a definitive answer, not a silent skip.
  if (
    remoteName !== 'origin' &&
    !(await shouldProbeGitRemote(repoPath, remoteName, connectionId, localGitOptions))
  ) {
    return null
  }
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
