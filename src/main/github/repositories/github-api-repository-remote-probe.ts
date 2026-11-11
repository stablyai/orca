import {
  withGitHubRepoExecution,
  getOwnerRepoForRemote,
  type GitHubRemoteIdentityProbeOptions,
  type LocalGitExecOptions
} from './github-repository-identity'
import type { GitHubRepositoryIdentity as GitHubApiRepository } from '../../../shared/github/repositories/repository-identity'
import { shouldProbeGitRemote } from '../../git/remotes/remote-name-listing'

import {
  getEnterpriseGitHubRepoSlug,
  getEnterpriseGitHubRepoSlugForRemote,
  getEnterpriseGitHubRepoSlugForRemoteUrl
} from './github-enterprise-repository'
import { classifyGitHubOwnerRepoFromRemoteUrl } from './github-ssh-host-alias-resolution'
import {
  githubApiRepositoryProbeCacheKey,
  resolveGitHubApiRepositoryProbe
} from './github-api-repository-probe'

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

/** Resolve this remote exactly; auth-gate Enterprise hosts so other forges cannot route to GitHub. */
export async function getGitHubApiRepositoryForRemote(
  repoPath: string,
  remoteName: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {},
  probeOptions: GitHubRemoteIdentityProbeOptions = {}
): Promise<GitHubApiRepository | null> {
  return withGitHubRepoExecution(repoPath, connectionId, localGitOptions, async () => {
    // Why: skip remotes the listing says are absent; origin stays unconditional so its absence is definitive.
    if (
      remoteName !== 'origin' &&
      !(await shouldProbeGitRemote(repoPath, remoteName, connectionId, localGitOptions))
    ) {
      return null
    }
    // Generic PR resolution prefers upstream; this entry point must honor the selected remote.
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
      // Undefined means auth inventory was unreadable; do not cache transient probe failures.
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
  })
}

export async function getOriginGitHubApiRepository(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitHubApiRepository | null> {
  return getGitHubApiRepositoryForRemote(repoPath, 'origin', connectionId, localGitOptions)
}

/** A remote URL's repository, for URLs no remote name resolves to (a separate `pushurl`). */
export async function getGitHubApiRepositoryForRemoteUrl(
  repoPath: string,
  remoteUrl: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<GitHubApiRepository | null> {
  const github = await classifyGitHubOwnerRepoFromRemoteUrl(remoteUrl, {
    repoPath,
    connectionId,
    ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
  })
  if (github.kind === 'github') {
    return { ...github.ownerRepo, host: 'github.com' }
  }
  if (github.kind === 'indeterminate') {
    return null
  }
  return (
    (await getEnterpriseGitHubRepoSlugForRemoteUrl(
      repoPath,
      remoteUrl,
      connectionId,
      localGitOptions
    )) ?? null
  )
}
