import { readLocalGitConfigSignature } from '../../github/repositories/local-git-config-signature'
import { runCoalescedProbe, type CoalescedProbes } from './coalesced-probe'
import type { GitAdmissionTier } from '../../../shared/rpc-contract/source-control/git-admission-tier-params'
import { REMOTE_URL_PROBE_TIMEOUT_MS } from './remote-git-probe-timeout'
import { gitExecFileAsync } from '../command-runner/git-exec-file'

export type RemoteNameListingGitOptions = {
  wslDistro?: string
  admissionTier?: GitAdmissionTier
}

const SIGNED_REMOTE_NAME_LISTING_TTL_MS = 5 * 60_000
export const UNSIGNED_REMOTE_NAME_LISTING_TTL_MS = 30_000
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
  localGitOptions: RemoteNameListingGitOptions = {}
): string {
  return `local:${localGitOptions.wslDistro ?? 'host'}\0${repoPath}`
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
  localGitOptions: RemoteNameListingGitOptions = {}
): { repoPath: string; connectionId: null; wslDistro?: string } {
  return {
    repoPath,
    connectionId: null,
    ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
  }
}

/** Cache repo/runtime names; failed or SSH-local reads return null so callers cannot infer a missing upstream. */
export async function listCachedRemoteNames(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: RemoteNameListingGitOptions = {}
): Promise<string[] | null> {
  if (connectionId) {
    return null
  }
  const cacheKey = remoteNameListingCacheKey(repoPath, localGitOptions)
  const now = Date.now()
  pruneRemoteNameListingCache(now)
  const cached = remoteNameListingCache.get(cacheKey)
  if (cached && cached.expiresAt > now) {
    if (cached.configSignature !== undefined) {
      const currentSignature = await readLocalGitConfigSignature(
        listingGitConfigContext(repoPath, localGitOptions)
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
    const configContext = listingGitConfigContext(repoPath, localGitOptions)
    const configSignatureBefore = await readLocalGitConfigSignature(configContext)
    const remotes = await listUncachedRemoteNames(repoPath, localGitOptions)
    if (remotes === null) {
      return null
    }
    if (ownsKey()) {
      const configSignatureAfter = await readLocalGitConfigSignature(configContext)
      const configSignature =
        configSignatureBefore !== undefined && configSignatureBefore === configSignatureAfter
          ? configSignatureAfter
          : undefined
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
  localGitOptions: RemoteNameListingGitOptions = {}
): Promise<string[] | null> {
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

/** True only when this repo's fresh, config-signed listing lacks the remote; reads no Git and spawns
 *  nothing, so a cold or unsigned listing (WSL, unreadable config) or an SSH repo says false. */
export async function isRemoteListedAbsent(
  repoPath: string,
  remoteName: string,
  connectionId?: string | null,
  localGitOptions: RemoteNameListingGitOptions = {}
): Promise<boolean> {
  if (connectionId) {
    return false
  }
  const cached = remoteNameListingCache.get(remoteNameListingCacheKey(repoPath, localGitOptions))
  if (
    cached?.configSignature === undefined ||
    cached.expiresAt <= Date.now() ||
    cached.remotes.includes(remoteName)
  ) {
    return false
  }
  const current = await readLocalGitConfigSignature(
    listingGitConfigContext(repoPath, localGitOptions)
  )
  return current === cached.configSignature
}
