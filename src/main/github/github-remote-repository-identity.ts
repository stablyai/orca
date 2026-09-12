import type { GitHubOwnerRepo } from '../../shared/github/pull-request-types'
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
import { readLocalGitConfigSignature } from './local-git-config-signature'

// Why: cache the uncached Enterprise remote probe used by hot paths.
const ORIGIN_REPO_CACHE_TTL_MS = 30_000
const ORIGIN_REPO_CACHE_MAX_ENTRIES = 512
const originRepoCache = new Map<
  string,
  { value: GitHubOwnerRepo | null; expiresAt: number; configSignature?: string }
>()
const originRepoInFlight = new Map<string, Promise<GitHubOwnerRepo | null>>()

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
): Promise<GitHubOwnerRepo | null> {
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
  const signatureContext = {
    repoPath,
    connectionId: connectionId ?? null,
    ...localGitOptions
  }
  const now = Date.now()
  pruneOriginRepoCache(now)
  const cached = originRepoCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    // Revalidate signed hits so a changed remote is visible before the TTL.
    if (cached.configSignature === undefined) {
      return cached.value
    }
    const currentSignature = await readLocalGitConfigSignature(signatureContext)
    if (currentSignature === cached.configSignature) {
      return cached.value
    }
    originRepoCache.delete(cacheKey)
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
      const configSignature = await readLocalGitConfigSignature(signatureContext)
      originRepoCache.set(cacheKey, {
        value: slug,
        expiresAt: Date.now() + ORIGIN_REPO_CACHE_TTL_MS,
        ...(configSignature ? { configSignature } : {})
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
