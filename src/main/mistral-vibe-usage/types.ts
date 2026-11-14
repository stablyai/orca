import type {
  UsageDailyAggregate,
  UsageLocationBreakdown,
  UsageLocationModelBreakdown,
  UsageModelBreakdown,
  UsageSession
} from '../usage/rollups/usage-rollup-records'

/** Vibe prices models in the user's config.toml, so cost is folded per session instead of at projection time. */
export type MistralVibeUsageMetric = {
  estimatedCostUsd: number | null
  hasUnpricedModels: boolean
}

export type MistralVibeUsageLocationBreakdown = UsageLocationBreakdown<MistralVibeUsageMetric>
export type MistralVibeUsageModelBreakdown = UsageModelBreakdown<MistralVibeUsageMetric>
export type MistralVibeUsageLocationModelBreakdown =
  UsageLocationModelBreakdown<MistralVibeUsageMetric>
export type MistralVibeUsageSession = UsageSession<MistralVibeUsageMetric>
export type MistralVibeUsageDailyAggregate = UsageDailyAggregate<MistralVibeUsageMetric>

export type MistralVibeUsageProcessedFile = {
  path: string
  mtimeMs: number
  size: number
  /** Reparse when the user edits model prices, which the index mtime cannot reveal. */
  pricingMtimeMs: number | null
}

export type MistralVibeUsagePersistedFile = MistralVibeUsageProcessedFile & {
  sessions: MistralVibeUsageSession[]
  dailyAggregates: MistralVibeUsageDailyAggregate[]
}

export type MistralVibeUsagePersistedState = {
  schemaVersion: number
  worktreeFingerprint: string | null
  processedFiles: MistralVibeUsagePersistedFile[]
  sessions: MistralVibeUsageSession[]
  dailyAggregates: MistralVibeUsageDailyAggregate[]
  scanState: {
    enabled: boolean
    lastScanStartedAt: number | null
    lastScanCompletedAt: number | null
    lastScanError: string | null
  }
}

export type MistralVibeUsageParsedEvent = {
  sessionId: string
  timestamp: string
  eventKey: string
  model: string | null
  cwd: string | null
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

export type MistralVibeUsageAttributedEvent = MistralVibeUsageParsedEvent &
  MistralVibeUsageMetric & {
    day: string
    projectKey: string
    projectLabel: string
    repoId: string | null
    worktreeId: string | null
  }
