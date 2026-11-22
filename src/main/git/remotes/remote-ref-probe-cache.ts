import { readLocalGitConfigSignature } from '../../github/repositories/local-git-config-signature'
import { runCoalescedProbe, type CoalescedProbes } from './coalesced-probe'
import { isTransientGitProbeError, readSignedRemoteUrl } from './remote-url-probe'
import type { GitAdmissionTier } from '../../../shared/rpc-contract/source-control/git-admission-tier-params'

const REPO_REF_CACHE_MAX_ENTRIES = 512

// Expire negatives and unsigned (WSL) answers so remote changes appear without restart or config watchers.
export const NEGATIVE_ENTRY_TTL_MS = 5 * 60_000

type CachedRepoRef<Ref> = { value: Ref | null; expiresAt: number; configSignature?: string }

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

  function remember(cacheKey: string, value: Ref | null, configSignature?: string): void {
    // Only a config signature proves a hit still matches the remote URL; unsigned identity expires.
    repoRefCache.set(cacheKey, {
      value,
      expiresAt:
        value !== null && configSignature !== undefined
          ? Number.POSITIVE_INFINITY
          : Date.now() + NEGATIVE_ENTRY_TTL_MS,
      configSignature
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
    localGitOptions: RemoteRefLocalGitOptions,
    configSignature: string | undefined
  ): Promise<Ref | null> {
    // Stale probes may answer their own callers, but cannot publish over a successor.
    const publish = (value: Ref | null, signature: string | undefined): void => {
      if (ownsKey()) {
        remember(cacheKey, value, signature)
      }
    }
    try {
      const read = await readSignedRemoteUrl(
        {
          repoPath,
          connectionId,
          ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {}),
          ...(localGitOptions.admissionTier ? { admissionTier: localGitOptions.admissionTier } : {})
        },
        remoteName,
        configSignature
      )
      // null means an SSH repo unavailable to this local reader, not a missing remote.
      if (read === null) {
        return null
      }
      const result = parseRemoteUrl(read.url)
      // A URL shared earlier in the pass may predate our signature.
      publish(result, read.configSignature)
      return result
    } catch (error) {
      // Transient probe failure cannot establish a negative cache entry.
      if (isTransientGitProbeError(error)) {
        return null
      }
      publish(null, configSignature)
      return null
    }
  }

  return {
    async get(repoPath, remoteName, connectionId, localGitOptions = {}) {
      const runtimeKey = connectionId || `local:${localGitOptions.wslDistro ?? 'host'}`
      const cacheKey = `${runtimeKey}\0${repoPath}\0${remoteName}`
      // Signed before the read, so a config edit during the probe forces the next hit to re-probe.
      const configSignature = await readLocalGitConfigSignature({
        repoPath,
        connectionId,
        wslDistro: localGitOptions.wslDistro
      })
      const cached = repoRefCache.get(cacheKey)
      if (cached) {
        if (cached.expiresAt > Date.now() && cached.configSignature === configSignature) {
          return cached.value
        }
        repoRefCache.delete(cacheKey)
      }
      // Coalesce worktree-list bursts so each branch does not spawn the same probe.
      return runCoalescedProbe(inFlight, `${cacheKey}\0${configSignature ?? ''}`, (ownsKey) =>
        probe(
          cacheKey,
          ownsKey,
          repoPath,
          remoteName,
          connectionId,
          localGitOptions,
          configSignature
        )
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
