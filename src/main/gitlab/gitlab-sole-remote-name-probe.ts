import { runCoalescedProbe, type CoalescedProbes } from '../git/coalesced-probe'
import { NEGATIVE_ENTRY_TTL_MS } from '../git/remote-ref-probe-cache'
import { REMOTE_URL_PROBE_TIMEOUT_MS } from '../git/remote-url-probe'
import { gitExecFileAsync } from '../git/runner'
import { getSshGitProvider, getSshGitProviderGeneration } from '../providers/ssh-git-dispatch'
import type { LocalGitExecOptions } from './gitlab-known-host-probe'

const CACHE_MAX_ENTRIES = 512

type CachedRemoteName = { value: string | null; expiresAt: number }

const cache = new Map<string, CachedRemoteName>()
const inFlight: CoalescedProbes<string | null> = new Map()

function remember(cacheKey: string, value: string | null): void {
  // Remote topology can change without an Orca-observable mutation on SSH/WSL.
  cache.set(cacheKey, {
    value,
    expiresAt: Date.now() + NEGATIVE_ENTRY_TTL_MS
  })
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value
    if (oldestKey === undefined) {
      return
    }
    cache.delete(oldestKey)
  }
}

function runtimeKey(
  connectionId: string | null | undefined,
  localGitOptions: LocalGitExecOptions
): string {
  return connectionId
    ? `${connectionId}:${getSshGitProviderGeneration(connectionId)}`
    : `local:${localGitOptions.wslDistro ?? 'host'}`
}

async function probeSoleRemoteName(
  cacheKey: string,
  ownsKey: () => boolean,
  repoPath: string,
  connectionId: string | null | undefined,
  localGitOptions: LocalGitExecOptions
): Promise<string | null> {
  try {
    const result = connectionId
      ? await getSshGitProvider(connectionId)?.exec(['remote'], repoPath, {
          signal: AbortSignal.timeout(REMOTE_URL_PROBE_TIMEOUT_MS)
        })
      : await gitExecFileAsync(['remote'], {
          cwd: repoPath,
          timeout: REMOTE_URL_PROBE_TIMEOUT_MS,
          ...(localGitOptions.wslDistro ? { wslDistro: localGitOptions.wslDistro } : {})
        })
    if (!result) {
      return null
    }
    const remoteNames = [
      ...new Set(
        result.stdout
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
      )
    ]
    const remoteName = remoteNames.length === 1 ? remoteNames[0]! : null
    if (ownsKey()) {
      remember(cacheKey, remoteName)
    }
    return remoteName
  } catch {
    // Why: a failed list says nothing about topology and must self-heal immediately.
    return null
  }
}

export async function getSoleRemoteName(
  repoPath: string,
  connectionId?: string | null,
  localGitOptions: LocalGitExecOptions = {}
): Promise<string | null> {
  const cacheKey = `${runtimeKey(connectionId, localGitOptions)}\0${repoPath}`
  const cached = cache.get(cacheKey)
  if (cached) {
    if (cached.expiresAt > Date.now()) {
      return cached.value
    }
    cache.delete(cacheKey)
  }
  return runCoalescedProbe(inFlight, cacheKey, (ownsKey) =>
    probeSoleRemoteName(cacheKey, ownsKey, repoPath, connectionId, localGitOptions)
  )
}

export async function resolveFromSoleRemote<T>(
  repoPath: string,
  excludedRemoteNames: readonly string[],
  connectionId: string | null | undefined,
  localGitOptions: LocalGitExecOptions,
  resolveRemote: (remoteName: string) => Promise<T | null>
): Promise<T | null> {
  const remoteName = await getSoleRemoteName(repoPath, connectionId, localGitOptions)
  if (!remoteName || excludedRemoteNames.includes(remoteName)) {
    return null
  }
  return resolveRemote(remoteName)
}

export function clearSoleRemoteNameProbeCache(): void {
  cache.clear()
  inFlight.clear()
}

/** @internal - exposed for tests only */
export function _getSoleRemoteNameProbeCacheSize(): number {
  return cache.size
}
