import { join } from 'node:path'
import { claudeProfileHistoryDirs } from '../claude-accounts/claude-profile-installed-router'
import {
  clearAiVaultBackgroundRestartCircuit,
  resetAiVaultScannerBackgroundForTests,
  scanAiVaultSessionsInBackground
} from './session-scanner-background'
import { getCachedWslDistros, hasCachedWslDistros, listRunningWslHomeDirsAsync } from '../wsl'
import { filterPathsToRunningWslDistrosAsync } from '../wsl-running-path-filter'
import {
  isAiVaultScanCancelledError,
  type AiVaultListArgs,
  type AiVaultListResult
} from '../../shared/ai-vault-types'
import { aiVaultLocalScanKey, aiVaultLocalScanScopeKey } from '../../shared/ai-vault-local-scan-key'
import type { AiVaultScanOptions } from './session-scanner-types'
import { prepareOpenCodeWslReaders } from './opencode-wsl-runtime-preparation'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { AiVaultScanCoordinator } from './ai-vault-scan-coordinator'
import {
  attachAiVaultScopeCwdAliases,
  resolveAiVaultScopeRealPaths
} from './session-scope-real-paths'
import {
  startLocalAiVaultScanProgress,
  type LocalAiVaultScanProgressHandle
} from './ai-vault-local-scan-progress'
import {
  aiVaultCachedDepthServes,
  requestedAiVaultSessionDepth,
  truncateAiVaultListResult,
  type AiVaultSessionDepth
} from '../../shared/ai-vault-session-depth'

// Desktop and runtime RPC share this cache to avoid duplicate scans when mobile and desktop open together.
const AI_VAULT_CACHE_TTL_MS = 60_000

export class AiVaultLocalScanError extends Error {
  constructor(
    readonly scanId: string,
    readonly original: unknown
  ) {
    super(original instanceof Error ? original.message : String(original))
  }
}

// Configure sources through the runtime service; headless serve never runs window-only IPC registration.
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
// Reject cache writes from scans that began before invalidation, or late results can resurrect deleted sessions.
let cacheGeneration = 0

export function configureAiVaultSessionSources(next: AiVaultSessionSources): void {
  sources = next
}

/** Resolve fresh WSL roots for both listing and indexing; distros can start or stop between scans. */
export async function localAiVaultScanRoots(): Promise<
  Required<Pick<AiVaultScanOptions, 'additionalCodexSessionsDirs' | 'wslHomeDirs'>> &
    Pick<AiVaultScanOptions, 'executionHostId' | 'wslOpenCodeReaders' | 'claudeProfileProjectsDirs'>
> {
  const [additionalCodexHomes, wslHomeDirs] = await Promise.all([
    filterPathsToRunningWslDistrosAsync(configuredAdditionalCodexHomePaths()),
    getAiVaultWslHomeDirs()
  ])
  return {
    additionalCodexSessionsDirs: additionalCodexHomes.map((homePath) => join(homePath, 'sessions')),
    wslHomeDirs,
    // Scanner workers have no account router; supply profile roots from this process.
    claudeProfileProjectsDirs: claudeProfileHistoryDirs('projects'),
    wslOpenCodeReaders: await prepareOpenCodeWslReaders(wslHomeDirs),
    // Runtime-addressed callers restamp host-local results at the RPC edge instead of rescanning.
    executionHostId: LOCAL_EXECUTION_HOST_ID
  }
}

/** Resume validation must use the same extra Codex homes that discovery lists. */
export function configuredAdditionalCodexHomePaths(): readonly string[] {
  return sources.getAdditionalCodexHomePaths?.() ?? []
}

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
  if (
    args?.force !== true &&
    cachedList?.key === key &&
    cachedList.expiresAt > now &&
    aiVaultCachedDepthServes(cachedList.depth, depth, args?.scopePaths)
  ) {
    return truncateAiVaultListResult(cachedList.result, depth, args?.scopePaths)
  }
  // Capture before the coordinator's start microtask so intervening invalidation still rejects the result.
  const startGeneration = cacheGeneration
  let progress: LocalAiVaultScanProgressHandle | null = null
  return scanCoordinator.run({
    key: scanKey,
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
      const scanned = await scanAiVaultSessionsInBackground(
        {
          includeAntigravityIdeSessions: args?.includeAntigravityIdeSessions,
          limit: args?.limit,
          unlimited: args?.unlimited,
          scopePaths: args?.scopePaths ? scope.scanScopePaths : undefined,
          ...(await localAiVaultScanRoots())
        },
        scanSignal,
        scanProgress
      )
      const result = { ...attachAiVaultScopeCwdAliases(scanned, scope), scanId }
      // Return pre-invalidation results to their caller, but never repopulate the cache with them.
      if (!scanSignal.aborted && startGeneration === cacheGeneration) {
        const current = cachedList
        if (
          args?.force === true ||
          current?.key !== key ||
          current.expiresAt <= Date.now() ||
          !aiVaultCachedDepthServes(current.depth, depth, args?.scopePaths)
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

// Subagent transcript validation shares these WSL-aware roots with discovery.
export async function getAiVaultWslHomeDirs(): Promise<string[]> {
  if (process.platform !== 'win32') {
    return []
  }
  // Trust only cached absence; a failed or new probe must not narrow WSL roots used by deletion and subagent validation.
  if (hasCachedWslDistros() && getCachedWslDistros()?.length === 0) {
    return []
  }
  return listRunningWslHomeDirsAsync()
}

// Invalidate cached results and disarm in-flight cache writes after deletion.
export function invalidateAiVaultSessionListCache(): void {
  cacheGeneration++
  cachedList = null
}

export function resetAiVaultSessionListCacheForTests(): void {
  invalidateAiVaultSessionListCache()
  scanCoordinator = new AiVaultScanCoordinator()
  sources = {}
  resetAiVaultScannerBackgroundForTests()
}
