import {
  clearAiVaultBackgroundRestartCircuit,
  resetAiVaultScannerBackgroundForTests,
  scanAiVaultSessionsInBackground
} from '../scan-service/session-scanner-background'
import {
  carryOverUnconfirmedWslSessions,
  resetAiVaultWslSessionCarryover
} from './ai-vault-wsl-session-carryover'
import {
  isAiVaultScanCancelledError,
  type AiVaultListArgs,
  type AiVaultListResult
} from '../../../shared/ai-vault/contracts/ai-vault-types'
import {
  aiVaultLocalScanKey,
  aiVaultLocalScanScopeKey
} from '../../../shared/ai-vault/scanning/ai-vault-local-scan-key'
import { AiVaultScanCoordinator } from '../scan-lifecycle/ai-vault-scan-coordinator'
import {
  resetAiVaultSessionSourcesForTests,
  resolveLocalAiVaultScanRoots
} from '../discovery/ai-vault-scan-roots'
import {
  attachAiVaultScopeCwdAliases,
  resolveAiVaultScopeRealPaths
} from '../scope/session-scope-real-paths'
import {
  startLocalAiVaultScanProgress,
  type LocalAiVaultScanProgressHandle
} from '../scan-lifecycle/ai-vault-local-scan-progress'
import {
  aiVaultCachedDepthServes,
  requestedAiVaultSessionDepth,
  truncateAiVaultListResult,
  type AiVaultSessionDepth
} from '../../../shared/ai-vault/scanning/ai-vault-session-depth'

// Desktop and runtime RPC share this cache to avoid duplicate scans when mobile and desktop open together.
const AI_VAULT_CACHE_TTL_MS = 60_000
// Why several: readers with other scopes (a plugin, the mobile app) must not evict the panel's list.
const AI_VAULT_CACHE_MAX_ENTRIES = 4

export class AiVaultLocalScanError extends Error {
  constructor(
    readonly scanId: string,
    readonly original: unknown
  ) {
    super(original instanceof Error ? original.message : String(original))
  }
}

type CachedAiVaultList = {
  key: string
  depth: AiVaultSessionDepth
  result: AiVaultListResult
  expiresAt: number
}

// Least recently used first.
const cachedLists = new Map<string, CachedAiVaultList>()
let scanCoordinator = new AiVaultScanCoordinator()
// Reject cache writes from scans that began before invalidation, or late results can resurrect deleted sessions.
let cacheGeneration = 0

export async function listAiVaultSessions(
  args?: AiVaultListArgs,
  options: { signal?: AbortSignal } = {}
): Promise<AiVaultListResult> {
  const key = aiVaultLocalScanScopeKey(args)
  const depth = requestedAiVaultSessionDepth(args)
  const scanKey = aiVaultLocalScanKey(args)
  const now = Date.now()
  if (args?.force === true) {
    clearAiVaultBackgroundRestartCircuit()
  }
  // A full list for the same paths holds every row a scope-only one would, so All -> Project needs no rescan.
  const fullKey = args?.scopeOnly ? aiVaultLocalScanScopeKey({ ...args, scopeOnly: false }) : key
  const cachedList =
    args?.force === true ? undefined : servingCachedList([key, fullKey], depth, args, now)
  if (cachedList) {
    return truncateAiVaultListResult(cachedList.result, depth, args?.scopePaths)
  }
  // Capture before the coordinator's start microtask so intervening invalidation still rejects the result.
  const startGeneration = cacheGeneration
  let progress: LocalAiVaultScanProgressHandle | null = null
  return scanCoordinator.run({
    // Isolate invalidated scans without changing the key used by progress readers.
    key: JSON.stringify({ scanKey, generation: startGeneration }),
    force: args?.force,
    signal: options.signal,
    onCreate: (scanId) => {
      progress = startLocalAiVaultScanProgress(scanKey, scanId)
    },
    onError: () => progress?.fail(),
    onReject: (error, scanId) =>
      isAiVaultScanCancelledError(error) ? error : new AiVaultLocalScanError(scanId, error),
    start: async (scanSignal, scanId) => {
      const scanProgress = progress
      if (!scanProgress) {
        throw new Error('Local scan progress was not created.')
      }
      const scope = await resolveAiVaultScopeRealPaths(args?.scopePaths ?? [])
      const { roots, wslConfirmed } = await resolveLocalAiVaultScanRoots()
      const scanned = await scanAiVaultSessionsInBackground(
        {
          includeAntigravityIdeSessions: args?.includeAntigravityIdeSessions,
          limit: args?.limit,
          unlimited: args?.unlimited,
          scopePaths: args?.scopePaths ? scope.scanScopePaths : undefined,
          scopeOnly: args?.scopeOnly,
          ...roots
        },
        scanSignal,
        scanProgress
      )
      const result = carryOverUnconfirmedWslSessions(
        key,
        { ...attachAiVaultScopeCwdAliases(scanned, scope), scanId },
        wslConfirmed
      )
      // Return pre-invalidation results to their caller, but never repopulate the cache with them.
      if (!scanSignal.aborted && startGeneration === cacheGeneration) {
        const current = cachedLists.get(key)
        if (
          args?.force === true ||
          !current ||
          current.expiresAt <= Date.now() ||
          !aiVaultCachedDepthServes(current.depth, depth, args?.scopePaths)
        ) {
          // A forced refresh supersedes every list: an older one for another scope (the
          // scope-only view a full list also serves) must not be served after it.
          if (args?.force === true) {
            cachedLists.clear()
          }
          rememberCachedList({
            key,
            depth,
            result,
            expiresAt: Date.now() + AI_VAULT_CACHE_TTL_MS
          })
        }
      }
      return result
    }
  })
}

/** The fresh entry for the first key that serves this depth; a hit becomes the most recent. */
function servingCachedList(
  keys: readonly string[],
  depth: AiVaultSessionDepth,
  args: AiVaultListArgs | undefined,
  now: number
): CachedAiVaultList | undefined {
  for (const key of keys) {
    const entry = cachedLists.get(key)
    if (
      entry &&
      entry.expiresAt > now &&
      aiVaultCachedDepthServes(entry.depth, depth, args?.scopePaths)
    ) {
      cachedLists.delete(key)
      cachedLists.set(key, entry)
      return entry
    }
  }
  return undefined
}

function rememberCachedList(entry: CachedAiVaultList): void {
  cachedLists.delete(entry.key)
  cachedLists.set(entry.key, entry)
  for (const oldest of cachedLists.keys()) {
    if (cachedLists.size <= AI_VAULT_CACHE_MAX_ENTRIES) {
      break
    }
    cachedLists.delete(oldest)
  }
}

export function aiVaultSessionListCacheGeneration(): number {
  return cacheGeneration
}

// Invalidate cached results and disarm in-flight cache writes after deletion.
export function invalidateAiVaultSessionListCache(): void {
  cacheGeneration++
  cachedLists.clear()
  // A deleted WSL session must not come back as a carried-over row.
  resetAiVaultWslSessionCarryover()
}

export function resetAiVaultSessionListCacheForTests(): void {
  invalidateAiVaultSessionListCache()
  scanCoordinator = new AiVaultScanCoordinator()
  resetAiVaultSessionSourcesForTests()
  resetAiVaultScannerBackgroundForTests()
}
