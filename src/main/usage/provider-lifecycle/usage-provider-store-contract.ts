import type { AgentTokenSession } from '../reporting/token-usage/agent-token-usage'
import type { AgentTokenUsage } from '../../../shared/telemetry-agent-token-usage-schema'
import type { UsageScanWorktreeRef } from './usage-provider-contract'
import type {
  UsageCacheSplitRequest,
  UsageCacheSplitResult,
  UsageSourceCacheRef
} from '../cache/usage-source-cache-file'

type UsageProviderScanState = {
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
  readFallbackCache?: (path: string) => Promise<{ state: State; integrityVerified: boolean }>
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
