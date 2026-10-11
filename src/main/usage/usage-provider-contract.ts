import type { AgentTokenSession } from './agent-token-usage'
import type { AgentTokenUsage } from '../../shared/telemetry-agent-token-usage-schema'
import type {
  UsageCacheSplitRequest,
  UsageCacheSplitResult,
  UsageSourceCacheRef
} from './usage-source-cache-file'

/**
 * Seam a usage source implements to be scanned by Orca, including plugin-contributed ones.
 *
 * Deliberately generic over each provider's record types: Claude bills per turn while
 * Codex/OpenCode bill per event, and `cachedInput` is a subset of `input` for the latter but a
 * peer bucket for Claude. A single normalized record would push nullable handling onto every
 * consumer, so only the scan envelope is shared.
 */

export type UsageProviderId =
  | 'claude'
  | 'codex'
  | 'devin'
  | 'opencode'
  | 'muse'
  | `plugin:${string}`

/** Scan input. Distinct from `UsageWorktreeRef` in usage-worktree-metadata, which lacks `repoId`. */
export type UsageScanWorktreeRef = {
  repoId: string
  worktreeId: string
  path: string
  displayName: string
}

/** What a scan reports. The per-source scan cache stays wherever the scan ran, behind `sourceCache`. */
export type UsageScanResult<TSession, TDaily> = {
  sessions: readonly TSession[]
  dailyAggregates: readonly TDaily[]
}

export type UsageProvider<TSession, TDaily> = {
  readonly id: UsageProviderId
  readonly label: string
  /** Bumped when the persisted projection changes shape; older caches are discarded. */
  readonly schemaVersion: number
  scan(
    worktrees: UsageScanWorktreeRef[],
    sourceCache: UsageSourceCacheRef
  ): Promise<UsageScanResult<TSession, TDaily>>
}

export type UsageProviderScanState = {
  enabled: boolean
  lastScanStartedAt: number | null
  lastScanCompletedAt: number | null
  lastScanError: string | null
}

export type UsageProviderStoreState<SourceKey extends string> = {
  schemaVersion: number
  worktreeFingerprint: string | null
  sessions: unknown[]
  dailyAggregates: unknown[]
  scanState: UsageProviderScanState
} & Record<SourceKey, unknown[]>

export type UsageProviderStoreLifecycleConfig<
  SourceKey extends string,
  State extends UsageProviderStoreState<SourceKey>,
  DataPresenceKey extends string
> = {
  logTag: string
  resolveCacheFile: () => string
  createDefaultState: () => State
  normalizeState: (state: State) => State
  parseReport?: (
    text: string,
    parsed?: State,
    integrityVerified?: boolean
  ) => State | Promise<State>
  serializeReport?: (state: State) => string
  providerId?: 'claude'
  sourceKey: SourceKey
  dataPresenceKey: DataPresenceKey
  tokenUsage?: {
    provider: AgentTokenUsage['provider']
    selectSessions: (state: State) => AgentTokenSession[]
  }
  scan: (
    worktrees: UsageScanWorktreeRef[],
    sourceCache: UsageSourceCacheRef
  ) => Promise<Pick<State, 'sessions' | 'dailyAggregates'>>
  splitCacheFile: (request: UsageCacheSplitRequest) => Promise<UsageCacheSplitResult>
}

export type PublicUsageProviderScanState<DataPresenceKey extends string> =
  UsageProviderScanState & {
    isScanning: boolean
  } & Record<DataPresenceKey, boolean>
