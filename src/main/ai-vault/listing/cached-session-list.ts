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

export {
  configureAiVaultSessionSources,
  configuredAdditionalCodexHomePaths,
  getAiVaultWslHomeDirs,
  getAiVaultWslScanHomeDirs,
  localAiVaultScanRoots,
  type AiVaultSessionSources
} from '../discovery/ai-vault-scan-roots'

// Desktop and runtime RPC share this cache to avoid duplicate scans when mobile and desktop open together.
const AI_VAULT_CACHE_TTL_MS = 60_000
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
  revision: number
  depth: AiVaultSessionDepth
  result: AiVaultListResult
  expiresAt: number
}

const cachedLists = new Map<string, CachedAiVaultList>()
let scanCoordinator = new AiVaultScanCoordinator()
// Refresh ordering belongs to actual scans, independent of explicit invalidation.
let nextScanRevision = 0
let refreshedRevision = 0
// Refresh fences cache writes; only invalidation splits aggregate requests already in flight.
let invalidationGeneration = 0

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
  const startGeneration = invalidationGeneration
  let revision = 0
  let progress: LocalAiVaultScanProgressHandle | null = null
  return scanCoordinator.run({
    // Isolate invalidated scans without changing the key used by progress readers.
    key: JSON.stringify({ scanKey, generation: invalidationGeneration }),
    force: args?.force,
    signal: options.signal,
    onCreate: (scanId) => {
      revision = ++nextScanRevision
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
      if (
        !scanSignal.aborted &&
        startGeneration === invalidationGeneration &&
        revision >= refreshedRevision
      ) {
        if (args?.force === true) {
          // A fresh host scan invalidates other scopes and fences older in-flight cache writes.
          refreshedRevision = revision
          for (const [cachedKey, entry] of cachedLists) {
            if (entry.revision < revision) {
              cachedLists.delete(cachedKey)
            }
          }
        }
        const current = cachedLists.get(key)
        if (
          current === undefined ||
          current.revision < revision ||
          current.expiresAt <= Date.now() ||
          !aiVaultCachedDepthServes(current.depth, depth, args?.scopePaths)
        ) {
          rememberCachedList({
            key,
            revision,
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

function servingCachedList(
  keys: readonly string[],
  depth: AiVaultSessionDepth,
  args: AiVaultListArgs | undefined,
  now: number
): CachedAiVaultList | undefined {
  let selected: CachedAiVaultList | undefined
  for (const key of keys) {
    const entry = cachedLists.get(key)
    if (
      entry &&
      entry.expiresAt > now &&
      aiVaultCachedDepthServes(entry.depth, depth, args?.scopePaths) &&
      (!selected || entry.revision > selected.revision)
    ) {
      selected = entry
    }
  }
  if (selected) {
    cachedLists.delete(selected.key)
    cachedLists.set(selected.key, selected)
  }
  return selected
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
  return invalidationGeneration
}

// Invalidate cached results and disarm in-flight cache writes after deletion.
export function invalidateAiVaultSessionListCache(): void {
  invalidationGeneration++
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
