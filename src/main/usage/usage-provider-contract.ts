import type { AgentTokenSession } from './agent-token-usage'
import type { AgentTokenUsage } from '../../shared/telemetry-agent-token-usage-schema'
import type {
  UsageCacheSplitRequest,
  UsageCacheSplitResult,
  UsageSourceCacheRef
} from './usage-source-cache-file'

/** Provider-specific records preserve per-turn/per-event billing and different cache-input semantics; only the scan envelope is shared, including plugins. */

export type UsageProviderId =
  | 'claude'
  | 'codex'
  | 'devin'
  | 'opencode'
  | 'muse'
  | `plugin:${string}`

/** Unlike UsageWorktreeRef, scan attribution also needs repoId. */
export type UsageScanWorktreeRef = {
  repoId: string
  worktreeId: string
  path: string
  displayName: string
}

/** Only report projections cross back; sourceCache stays on the scan host. */
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
