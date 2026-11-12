import type { StoreRuntimeState } from '../store-runtime-state'
import {
  GITHUB_CACHE_BARRIER_BUSY_TIMEOUT_MS,
  GITHUB_CACHE_ROUTINE_BUSY_TIMEOUT_MS,
  writeGitHubCacheDatabase
} from './github-cache-database'
import {
  classifyRowCacheFailure,
  nextRetryDelayMs
} from '../../../sqlite/row-cache/row-cache-failure'

type GitHubCachePersistenceRuntime = Pick<
  StoreRuntimeState,
  | 'dataFile'
  | 'githubCacheDirty'
  | 'githubCacheLegacyFileHash'
  | 'githubCachePersistenceDisabled'
  | 'githubCachePersistedAt'
  | 'githubCachePersistTimer'
  | 'githubCacheRetryDelayMs'
  | 'profileMaintenancePending'
  | 'quitFlushStarted'
  | 'state'
  | 'writesFrozen'
>

/**
 * The cache only seeds next launch's sidebar before the first poll, so routine saves wait this
 * long; quit and explicit flush barriers save at once. A crash loses at most this much churn,
 * which the next poll refetches.
 */
const GITHUB_CACHE_PERSIST_INTERVAL_MS = 3 * 60_000
const GITHUB_CACHE_FIRST_RETRY_MS = 5_000

/**
 * `routine` saves wait for the interval (or a pending retry) and never run while maintenance,
 * finalization or a freeze owns the profile. `barrier` is an admitted maintenance or final flush:
 * it saves now. Barriers are best-effort for this disposable cache: a failure (such as another
 * writer's lock) is logged and retried later rather than failing quit or a profile switch, and
 * the cost is stale sidebar facts until the first poll after restart.
 */
export function persistGithubCache(
  runtime: GitHubCachePersistenceRuntime,
  mode: 'routine' | 'barrier'
): void {
  if (!runtime.githubCacheDirty || runtime.githubCachePersistenceDisabled) {
    return
  }
  if (mode === 'barrier') {
    writeGithubCacheNow(runtime, true)
    return
  }
  // An armed timer is the next save: the interval or a busy retry's backoff.
  if (isFenced(runtime) || runtime.githubCachePersistTimer !== null) {
    return
  }
  const remaining = runtime.githubCachePersistedAt + GITHUB_CACHE_PERSIST_INTERVAL_MS - Date.now()
  if (remaining <= 0) {
    writeGithubCacheNow(runtime, false)
  } else {
    armGithubCacheTimer(runtime, remaining, 'interval')
  }
}

/** Maintenance, freeze or quit owns the profile; resume (if any) rearms through persistGithubCache. */
export function suspendGithubCachePersistence(runtime: GitHubCachePersistenceRuntime): void {
  if (runtime.githubCachePersistTimer !== null) {
    clearTimeout(runtime.githubCachePersistTimer)
    runtime.githubCachePersistTimer = null
  }
}

/** `retry` saves at its own backoff deadline; `interval` re-applies the routine cadence. */
function armGithubCacheTimer(
  runtime: GitHubCachePersistenceRuntime,
  delayMs: number,
  kind: 'interval' | 'retry'
): void {
  runtime.githubCachePersistTimer = setTimeout(() => {
    runtime.githubCachePersistTimer = null
    if (kind === 'interval') {
      persistGithubCache(runtime, 'routine')
    } else if (runtime.githubCacheDirty && !isFenced(runtime)) {
      writeGithubCacheNow(runtime, false)
    }
  }, delayMs)
  runtime.githubCachePersistTimer.unref?.()
}

function isFenced(runtime: GitHubCachePersistenceRuntime): boolean {
  return runtime.writesFrozen || runtime.profileMaintenancePending || runtime.quitFlushStarted
}

function writeGithubCacheNow(runtime: GitHubCachePersistenceRuntime, barrier: boolean): void {
  suspendGithubCachePersistence(runtime)
  try {
    // Synchronous: no later mutation can interleave, so the cache is clean once this returns.
    writeGitHubCacheDatabase(runtime.dataFile, runtime.state.githubCache, {
      busyTimeoutMs: barrier
        ? GITHUB_CACHE_BARRIER_BUSY_TIMEOUT_MS
        : GITHUB_CACHE_ROUTINE_BUSY_TIMEOUT_MS,
      importedLegacyFileHash: runtime.githubCacheLegacyFileHash
    })
    runtime.githubCacheDirty = false
    runtime.githubCacheLegacyFileHash = null
    runtime.githubCachePersistedAt = Date.now()
    runtime.githubCacheRetryDelayMs = 0
  } catch (error) {
    // Another connection holds the lock (or the disk refused): back off rather than block.
    const delay = nextRetryDelayMs(runtime.githubCacheRetryDelayMs, {
      minMs: GITHUB_CACHE_FIRST_RETRY_MS,
      maxMs: GITHUB_CACHE_PERSIST_INTERVAL_MS
    })
    runtime.githubCacheRetryDelayMs = delay
    armGithubCacheTimer(runtime, delay, 'retry')
    if (classifyRowCacheFailure(error) !== 'busy') {
      console.warn('[persistence] Failed to write github cache snapshot:', error)
    }
  }
}
