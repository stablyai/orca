import {
  normalizeGitHubApiHost,
  parseGitHubRemoteIdentity,
  preferredGitHubApiHost
} from './github-remote-identity-parsing'
import { getRemoteUrlForRepo, githubRepoContext } from './github-repository-identity'

// Why (issue #1715): mirror the owner/repo positive-cache window so a repo's
// resolved gh API host and its owner/repo lookups expire on the same cadence.
const REPO_HOST_CACHE_TTL_MS = 30_000

const repoHostCache = new Map<string, { value: string | null; expiresAt: number }>()

/** @internal - exposed for tests only */
export function _resetRepoHostCache(): void {
  repoHostCache.clear()
}

// Why (issue #1715): in multi-host setups gh must target the repo's own host.
// Prefer the upstream remote's host, then origin's, so forks of a GHE repo
// route to the enterprise host rather than the user's default github.com.
export async function getGitHubApiHostForRepo(
  repoPath: string,
  connectionId?: string | null
): Promise<string | null> {
  const context = githubRepoContext(repoPath, connectionId)
  const cacheKey = `${context.connectionId ?? 'local'}\0${context.repoPath}\0api-host`
  const cached = repoHostCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value
  }
  if (cached) {
    repoHostCache.delete(cacheKey)
  }

  let fallback: string | null = null
  for (const remoteName of ['upstream', 'origin']) {
    try {
      const remoteUrl = await getRemoteUrlForRepo(context, remoteName)
      const identity = remoteUrl ? parseGitHubRemoteIdentity(remoteUrl) : null
      const host = identity ? normalizeGitHubApiHost(identity.host) : null
      if (!host) {
        continue
      }
      if (preferredGitHubApiHost(host)) {
        repoHostCache.set(cacheKey, {
          value: host,
          expiresAt: Date.now() + REPO_HOST_CACHE_TTL_MS
        })
        return host
      }
      fallback ??= host
    } catch {
      // ignore missing remotes or non-git paths
    }
  }

  repoHostCache.set(cacheKey, {
    value: fallback,
    expiresAt: Date.now() + REPO_HOST_CACHE_TTL_MS
  })
  return fallback
}
