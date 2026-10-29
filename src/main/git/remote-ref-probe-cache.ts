import { runCoalescedProbe, type CoalescedProbes } from './coalesced-probe'
import { isTransientGitProbeError, readRemoteUrl } from './remote-url-probe'
import type { GitAdmissionTier } from './command-runner/git-exec-options'

const REPO_REF_CACHE_MAX_ENTRIES = 512

// Expire negatives so newly added remotes appear without restart, including on SSH/WSL without config watchers.
export const NEGATIVE_ENTRY_TTL_MS = 5 * 60_000

type CachedRepoRef<Ref> = { value: Ref | null; expiresAt: number }

export type RemoteRefLocalGitOptions = {
  wslDistro?: string
  admissionTier?: GitAdmissionTier
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
  const repoRefCache = new Map<string, CachedRepoRef<Ref>>()
  const inFlight: CoalescedProbes<Ref | null> = new Map()

  function remember(cacheKey: string, value: Ref | null): void {
    repoRefCache.set(cacheKey, {
      value,
      expiresAt: value === null ? Date.now() + NEGATIVE_ENTRY_TTL_MS : Number.POSITIVE_INFINITY
    })
    while (repoRefCache.size > REPO_REF_CACHE_MAX_ENTRIES) {
      const oldestKey = repoRefCache.keys().next().value
      if (oldestKey === undefined) {
        return
      }
      repoRefCache.delete(oldestKey)
    }
  }

  async function probe(
    cacheKey: string,
    ownsKey: () => boolean,
    repoPath: string,
    remoteName: string,
    connectionId: string | null | undefined,
    localGitOptions: RemoteRefLocalGitOptions
  ): Promise<Ref | null> {
    // Stale probes may answer their own callers, but cannot publish over a successor.
    const publish = (value: Ref | null): void => {
      if (ownsKey()) {
        remember(cacheKey, value)
      }
    }
    try {
      const stdout = await readRemoteUrl(
        {
          repoPath,
          connectionId,
          ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {}),
          ...(localGitOptions.admissionTier ? { admissionTier: localGitOptions.admissionTier } : {})
        },
        remoteName
      )
      // null means an SSH repo unavailable to this local reader, not a missing remote.
      if (stdout === null) {
        return null
      }
      const result = parseRemoteUrl(stdout)
      publish(result)
      return result
    } catch (error) {
      // Transient probe failure cannot establish a negative cache entry.
      if (isTransientGitProbeError(error)) {
        return null
      }
      publish(null)
      return null
    }
  }

  return {
    async get(repoPath, remoteName, connectionId, localGitOptions = {}) {
      const runtimeKey = connectionId || `local:${localGitOptions.wslDistro ?? 'host'}`
      const cacheKey = `${runtimeKey}\0${repoPath}\0${remoteName}`
      const cached = repoRefCache.get(cacheKey)
      if (cached) {
        if (cached.expiresAt > Date.now()) {
          return cached.value
        }
        repoRefCache.delete(cacheKey)
      }
      // Coalesce worktree-list bursts so each branch does not spawn the same probe.
      return runCoalescedProbe(inFlight, cacheKey, (ownsKey) =>
        probe(cacheKey, ownsKey, repoPath, remoteName, connectionId, localGitOptions)
      )
    },
    clear() {
      repoRefCache.clear()
      inFlight.clear()
    },
    size() {
      return repoRefCache.size
    }
  }
}
