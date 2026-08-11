import { join } from 'node:path'
import {
  resetAiVaultScannerBackgroundForTests,
  scanAiVaultSessionsInBackground
} from './session-scanner-background'
import { getWslHomeAsync, listWslDistrosAsync } from '../wsl'
import type { AiVaultListArgs, AiVaultListResult } from '../../shared/ai-vault-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { AiVaultScanCoordinator } from './ai-vault-scan-coordinator'
import {
  aiVaultSessionDepthCovers,
  requestedAiVaultSessionDepth,
  truncateAiVaultListResult,
  type AiVaultSessionDepth
} from '../../shared/ai-vault-session-depth'

// Why: ONE module owns the scan cache so the desktop IPC handler AND the runtime
// RPC method share a single cache instance — opening the desktop panel and the
// mobile screen for the same scope must not double-scan hundreds of transcripts.
const AI_VAULT_CACHE_TTL_MS = 60_000

// Why: codex-home + WSL home dirs must be sourced from a serve-mode-reachable
// seam (the OrcaRuntimeService deps), NOT the window-only registerCoreHandlers
// path — `orca serve` never runs that path, so sourcing it there would silently
// drop managed-Codex sessions from remote/SSH results.
export type AiVaultSessionSources = {
  getAdditionalCodexHomePaths?: () => readonly string[]
}

type CachedAiVaultList = {
  key: string
  depth: AiVaultSessionDepth
  result: AiVaultListResult
  expiresAt: number
}

let cachedList: CachedAiVaultList | null = null
let scanCoordinator = new AiVaultScanCoordinator()
let sources: AiVaultSessionSources = {}
// Bumped on every invalidation. A scan that started before an invalidation
// carries the old generation and must not write its (now stale) result back
// into the cache — otherwise a delete's invalidation is silently undone by an
// in-flight scan that resolves just after it.
let cacheGeneration = 0

export function configureAiVaultSessionSources(next: AiVaultSessionSources): void {
  sources = next
}

export async function listAiVaultSessions(
  args?: AiVaultListArgs,
  options: { signal?: AbortSignal } = {}
): Promise<AiVaultListResult> {
  // Scope paths change the result set, so they must be part of the cache key.
  const key = JSON.stringify({ scopePaths: [...new Set(args?.scopePaths ?? [])].sort() })
  const depth = requestedAiVaultSessionDepth(args)
  const scanKey = JSON.stringify({ key, depth })
  const now = Date.now()
  // Why: opening this panel repeatedly should not re-parse hundreds of JSONL
  // transcripts; explicit refreshes bypass the cache and preempt stale scans.
  if (
    args?.force !== true &&
    cachedList?.key === key &&
    cachedList.expiresAt > now &&
    aiVaultSessionDepthCovers(cachedList.depth, depth)
  ) {
    return truncateAiVaultListResult(cachedList.result, depth, args?.scopePaths)
  }
  // Captured here, not inside start(): the coordinator defers start() by a
  // microtask, so an invalidation landing in that gap would otherwise be read
  // as having happened before this scan and leave the stale result cacheable.
  const startGeneration = cacheGeneration
  return scanCoordinator.run({
    key: scanKey,
    force: args?.force,
    signal: options.signal,
    start: async (scanSignal) => {
      const additionalCodexSessionsDirs =
        sources.getAdditionalCodexHomePaths?.().map((homePath) => join(homePath, 'sessions')) ?? []
      const result = await scanAiVaultSessionsInBackground(
        {
          limit: args?.limit,
          unlimited: args?.unlimited,
          scopePaths: args?.scopePaths,
          additionalCodexSessionsDirs,
          wslHomeDirs: await getAiVaultWslHomeDirs(),
          // Why: this scan is always host-local; callers addressing this host by a
          // runtime id get the result restamped at the RPC edge, never rescanned.
          executionHostId: LOCAL_EXECUTION_HOST_ID
        },
        scanSignal
      )
      // A delete (or other invalidation) landed while this scan was running:
      // its result predates the delete, so caching it would resurrect the
      // deleted session for the TTL. Return it to this caller but don't cache.
      if (!scanSignal.aborted && startGeneration === cacheGeneration) {
        const current = cachedList
        if (
          args?.force === true ||
          current?.key !== key ||
          current.expiresAt <= Date.now() ||
          !aiVaultSessionDepthCovers(current.depth, depth)
        ) {
          cachedList = {
            key,
            depth,
            result,
            expiresAt: Date.now() + AI_VAULT_CACHE_TTL_MS
          }
        }
      }
      return result
    }
  })
}

// Exported for the subagent-transcript IPC path, which validates
// renderer-supplied paths against the same WSL-aware Claude roots the scan uses.
export async function getAiVaultWslHomeDirs(): Promise<string[]> {
  if (process.platform !== 'win32') {
    return []
  }
  const homes = await Promise.all(
    (await listWslDistrosAsync()).map((distro) => getWslHomeAsync(distro))
  )
  return homes.filter((homeDir): homeDir is string => Boolean(homeDir))
}

// Drops the scan-result cache after a session is deleted so a non-force
// list call within the TTL can't still serve the trashed session. Bumping the
// generation also disarms any scan already in flight, so a scan that started
// before this call cannot write its pre-delete result back into the cache.
// Scan discovery itself walks disk first (session-scanner.ts), so a deleted
// file is never rediscovered — this only guards the cached RESULT.
export function invalidateAiVaultSessionListCache(): void {
  cacheGeneration++
  cachedList = null
}

// Why: tests reset module-level cache/source state between cases.
export function resetAiVaultSessionListCacheForTests(): void {
  invalidateAiVaultSessionListCache()
  scanCoordinator = new AiVaultScanCoordinator()
  sources = {}
  resetAiVaultScannerBackgroundForTests()
}
