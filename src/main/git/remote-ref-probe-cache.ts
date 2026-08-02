import { isTransientGitProbeError, readRemoteUrl } from './remote-url-probe'

/**
 * The "is this repo mine?" probe every forge integration runs: read the remote's
 * URL once per repo/runtime, cache what the provider's parser made of it, and
 * never cache an answer a failed probe never gave.
 */

const REPO_REF_CACHE_MAX_ENTRIES = 512

export type RemoteRefLocalGitOptions = {
  wslDistro?: string
}

export type RemoteRefProbeCache<Ref> = {
  get(
    repoPath: string,
    remoteName: string,
    connectionId?: string | null,
    localGitOptions?: RemoteRefLocalGitOptions
  ): Promise<Ref | null>
  clear(): void
  size(): number
}

export function createRemoteRefProbeCache<Ref>(
  parseRemoteUrl: (remoteUrl: string) => Ref | null
): RemoteRefProbeCache<Ref> {
  const repoRefCache = new Map<string, Ref | null>()

  function remember(cacheKey: string, value: Ref | null): void {
    repoRefCache.set(cacheKey, value)
    while (repoRefCache.size > REPO_REF_CACHE_MAX_ENTRIES) {
      const oldestKey = repoRefCache.keys().next().value
      if (oldestKey === undefined) {
        return
      }
      repoRefCache.delete(oldestKey)
    }
  }

  return {
    async get(repoPath, remoteName, connectionId, localGitOptions = {}) {
      const runtimeKey = connectionId ?? `local:${localGitOptions.wslDistro ?? 'host'}`
      const cacheKey = `${runtimeKey}\0${repoPath}\0${remoteName}`
      if (repoRefCache.has(cacheKey)) {
        return repoRefCache.get(cacheKey)!
      }
      try {
        const stdout = await readRemoteUrl(
          {
            repoPath,
            connectionId,
            ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
          },
          remoteName
        )
        if (stdout === null) {
          return null
        }
        const result = parseRemoteUrl(stdout)
        remember(cacheKey, result)
        return result
      } catch (error) {
        if (connectionId || isTransientGitProbeError(error)) {
          // Why: SSH provider failures are often transient reconnect/tunnel states,
          // and a probe killed on its deadline says nothing about the remote either;
          // caching them as "not this provider" would poison the repo for the session.
          return null
        }
        remember(cacheKey, null)
        return null
      }
    },
    clear() {
      repoRefCache.clear()
    },
    size() {
      return repoRefCache.size
    }
  }
}
