import { readLocalGitConfigSignature } from '../github/local-git-config-signature'
import { getSshGitProvider, getSshGitProviderGeneration } from '../providers/ssh-git-dispatch'
import { runCoalescedProbe, type CoalescedProbes } from './coalesced-probe'
import type { GitAdmissionTier } from './command-runner/git-exec-options'
import { REMOTE_URL_PROBE_TIMEOUT_MS } from './remote-url-probe'
import { gitExecFileAsync } from './runner'

export type RemoteNameListingGitOptions = {
  wslDistro?: string
  admissionTier?: GitAdmissionTier
}

const SIGNED_REMOTE_NAME_LISTING_TTL_MS = 5 * 60_000
const UNSIGNED_REMOTE_NAME_LISTING_TTL_MS = 30_000
const REMOTE_NAME_LISTING_CACHE_MAX_ENTRIES = 512

type CachedRemoteNames = {
  remotes: string[]
  expiresAt: number
  configSignature?: string
}

const remoteNameListingCache = new Map<string, CachedRemoteNames>()
const remoteNameListingInFlight: CoalescedProbes<string[] | null> = new Map()

/** @internal - exposed for tests only */
export function _resetRemoteNameListingCache(): void {
  remoteNameListingCache.clear()
  remoteNameListingInFlight.clear()
}

function parseRemoteNames(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

function remoteNameListingCacheKey(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: RemoteNameListingGitOptions = {}
): string {
  const runtimeKey = connectionId
    ? `ssh:${connectionId}:${getSshGitProviderGeneration(connectionId)}`
    : `local:${localGitOptions.wslDistro ?? 'host'}`
  return `${runtimeKey}\0${repoPath}`
}

function pruneRemoteNameListingCache(now: number): void {
  for (const [key, entry] of remoteNameListingCache) {
    if (entry.expiresAt <= now) {
      remoteNameListingCache.delete(key)
    }
  }
  while (remoteNameListingCache.size > REMOTE_NAME_LISTING_CACHE_MAX_ENTRIES) {
    const oldestKey = remoteNameListingCache.keys().next().value
    if (oldestKey === undefined) {
      return
    }
    remoteNameListingCache.delete(oldestKey)
  }
}

function listingGitConfigContext(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: RemoteNameListingGitOptions = {}
): { repoPath: string; connectionId: string | null; wslDistro?: string } {
  return {
    repoPath,
    connectionId: connectionId ?? null,
    ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
  }
}

/**
 * `git remote` names for one repo/runtime. Failed listings are not cached: a
 * missed `upstream` would otherwise send issue/PR resolvers to origin on a
 * contributor clone (#7331).
 */
export async function listCachedRemoteNames(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: RemoteNameListingGitOptions = {}
): Promise<string[] | null> {
  const cacheKey = remoteNameListingCacheKey(repoPath, connectionId, localGitOptions)
  const now = Date.now()
  pruneRemoteNameListingCache(now)
  const cached = remoteNameListingCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    if (cached.configSignature !== undefined) {
      const currentSignature = await readLocalGitConfigSignature(
        listingGitConfigContext(repoPath, connectionId, localGitOptions)
      )
      if (currentSignature === cached.configSignature) {
        return cached.remotes
      }
      remoteNameListingCache.delete(cacheKey)
    } else {
      return cached.remotes
    }
  }

  return runCoalescedProbe(remoteNameListingInFlight, cacheKey, async (ownsKey) => {
    const remotes = await listUncachedRemoteNames(repoPath, connectionId, localGitOptions)
    if (remotes === null) {
      return null
    }
    if (ownsKey()) {
      const configSignature = await readLocalGitConfigSignature(
        listingGitConfigContext(repoPath, connectionId, localGitOptions)
      )
      remoteNameListingCache.set(cacheKey, {
        remotes,
        expiresAt:
          Date.now() +
          (configSignature
            ? SIGNED_REMOTE_NAME_LISTING_TTL_MS
            : UNSIGNED_REMOTE_NAME_LISTING_TTL_MS),
        ...(configSignature ? { configSignature } : {})
      })
      pruneRemoteNameListingCache(Date.now())
    }
    return remotes
  })
}

async function listUncachedRemoteNames(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: RemoteNameListingGitOptions = {}
): Promise<string[] | null> {
  if (connectionId) {
    const provider = getSshGitProvider(connectionId)
    if (!provider) {
      return null
    }
    try {
      const { stdout } = await provider.exec(['remote'], repoPath, {
        signal: AbortSignal.timeout(REMOTE_URL_PROBE_TIMEOUT_MS)
      })
      return parseRemoteNames(stdout)
    } catch {
      return null
    }
  }
  try {
    const { stdout } = await gitExecFileAsync(['remote'], {
      cwd: repoPath,
      timeout: REMOTE_URL_PROBE_TIMEOUT_MS,
      ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {}),
      ...(localGitOptions.admissionTier ? { admissionTier: localGitOptions.admissionTier } : {})
    })
    return parseRemoteNames(stdout)
  } catch {
    return null
  }
}

/** Probe a named remote only when listing says it exists, or listing failed. */
export async function shouldProbeGitRemote(
  repoPath: string,
  remoteName: string,
  connectionId?: string | null,
  localGitOptions: RemoteNameListingGitOptions = {}
): Promise<boolean> {
  const remotes = await listCachedRemoteNames(repoPath, connectionId, localGitOptions)
  return remotes === null || remotes.includes(remoteName)
}
