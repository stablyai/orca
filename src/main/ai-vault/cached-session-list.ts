import { isWslUncPath } from '../../shared/wsl-paths'
import { join } from 'node:path'
import { claudeProfileHistoryDirs } from '../claude-accounts/claude-profile-installed-router'
import {
  clearAiVaultBackgroundRestartCircuit,
  resetAiVaultScannerBackgroundForTests,
  scanAiVaultSessionsInBackground
} from './session-scanner-background'
import { getCachedWslDistros, hasCachedWslDistros } from '../wsl'
import {
  listLastKnownRunningWslHomeDirs,
  readRunningWslHomeDirsUnlessStopped
} from '../wsl/wsl-home-unless-stopped'
import {
  carryOverUnconfirmedWslSessions,
  resetAiVaultWslSessionCarryover
} from './ai-vault-wsl-session-carryover'
import { filterPathsToRunningWslDistrosAsync } from '../wsl-running-path-filter'
import {
  isAiVaultScanCancelledError,
  type AiVaultListArgs,
  type AiVaultListResult
} from '../../shared/ai-vault-types'
import { aiVaultLocalScanKey, aiVaultLocalScanScopeKey } from '../../shared/ai-vault-local-scan-key'
import type { AiVaultScanOptions } from './session-scanner-types'
import { managedOpenCodeAccountDataDirs } from '../opencode/opencode-managed-account-data-dirs'
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

type LocalAiVaultScanRoots = Required<
  Pick<AiVaultScanOptions, 'additionalCodexSessionsDirs' | 'wslHomeDirs'>
> &
  Pick<
    AiVaultScanOptions,
    | 'executionHostId'
    | 'wslOpenCodeReaders'
    | 'claudeProfileProjectsDirs'
    | 'opencodeAccountDataDirs'
  >

/** Resolve fresh WSL roots for both listing and indexing; distros can start or stop between scans. */
export async function localAiVaultScanRoots(): Promise<LocalAiVaultScanRoots> {
  return (await resolveLocalAiVaultScanRoots()).roots
}

/** `wslConfirmed` is false when no confirmed running list was read: WSL rows are then unknown, not gone. */
async function resolveLocalAiVaultScanRoots(): Promise<{
  roots: LocalAiVaultScanRoots
  wslConfirmed: boolean
}> {
  const [additionalCodexHomes, wsl] = await Promise.all([
    // Confirmed only: a stale list could name a distro that stopped; a failed probe drops WSL homes.
    filterPathsToRunningWslDistrosAsync(configuredAdditionalCodexHomePaths(), {
      requireConfirmed: true
    }).catch(() => configuredAdditionalCodexHomePaths().filter((home) => !isWslUncPath(home))),
    scanWslHomeDirs()
  ])
  return {
    wslConfirmed: wsl.confirmed,
    roots: {
      additionalCodexSessionsDirs: additionalCodexHomes.map((homePath) =>
        join(homePath, 'sessions')
      ),
      wslHomeDirs: wsl.homes,
      // Scanner workers have no account router; supply profile roots from this process.
      claudeProfileProjectsDirs: claudeProfileHistoryDirs('projects'),
      opencodeAccountDataDirs: managedOpenCodeAccountDataDirs(),
      wslOpenCodeReaders: await prepareOpenCodeWslReaders(wsl.homes),
      // Runtime-addressed callers restamp host-local results at the RPC edge instead of rescanning.
      executionHostId: LOCAL_EXECUTION_HOST_ID
    }
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
    return truncateAiVaultListResult(
      cachedList.result,
      depth,
      args?.scopePaths,
      args?.selectedSessionId
    )
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
          selectedSessionId: args?.selectedSessionId,
          limit: args?.limit,
          unlimited: args?.unlimited,
          scopePaths: args?.scopePaths ? scope.scanScopePaths : undefined,
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

/** Trust cached absence of any distro; otherwise a confirmed running list (E9). */
async function scanWslHomeDirs(): Promise<{ homes: string[]; confirmed: boolean }> {
  if (
    process.platform !== 'win32' ||
    (hasCachedWslDistros() && getCachedWslDistros()?.length === 0)
  ) {
    return { homes: [], confirmed: true }
  }
  return readRunningWslHomeDirsUnlessStopped()
}

/** WSL homes for work that reads inside them: a stopped distro's home is absent, not refused. */
export async function getAiVaultWslScanHomeDirs(): Promise<string[]> {
  return (await scanWslHomeDirs()).homes
}

/**
 * WSL roots for checking a path a user act names (delete, subagent listing): a containment check
 * reads nothing, so a failed probe must not narrow them and keeps the last-known-good list.
 */
export async function getAiVaultWslHomeDirs(): Promise<string[]> {
  if (
    process.platform !== 'win32' ||
    (hasCachedWslDistros() && getCachedWslDistros()?.length === 0)
  ) {
    return []
  }
  return listLastKnownRunningWslHomeDirs()
}

export function aiVaultSessionListCacheGeneration(): number {
  return cacheGeneration
}

// Invalidate cached results and disarm in-flight cache writes after deletion.
export function invalidateAiVaultSessionListCache(): void {
  cacheGeneration++
  cachedList = null
  // A deleted WSL session must not come back as a carried-over row.
  resetAiVaultWslSessionCarryover()
}

export function resetAiVaultSessionListCacheForTests(): void {
  invalidateAiVaultSessionListCache()
  scanCoordinator = new AiVaultScanCoordinator()
  sources = {}
  resetAiVaultScannerBackgroundForTests()
}
