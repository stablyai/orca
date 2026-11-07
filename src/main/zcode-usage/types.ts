import type {
  UsageDailyAggregate,
  UsageLocationBreakdown,
  UsageLocationModelBreakdown,
  UsageModelBreakdown,
  UsageSession
} from '../usage/usage-rollup-records'

export type ZcodeUsageMetric = {
  cacheReadInputTokens: number
  cacheWriteInputTokens: number
}

export type ZcodeUsageLocationBreakdown = UsageLocationBreakdown<ZcodeUsageMetric>
export type ZcodeUsageModelBreakdown = UsageModelBreakdown<ZcodeUsageMetric>
export type ZcodeUsageLocationModelBreakdown = UsageLocationModelBreakdown<ZcodeUsageMetric>
export type ZcodeUsageSession = UsageSession<ZcodeUsageMetric>
export type ZcodeUsageDailyAggregate = UsageDailyAggregate<ZcodeUsageMetric>

export type ZcodeUsageProcessedDatabase = {
  path: string
  mtimeMs: number
  size: number
}

export type ZcodeUsagePersistedDatabase = ZcodeUsageProcessedDatabase & {
  sessions: ZcodeUsageSession[]
  dailyAggregates: ZcodeUsageDailyAggregate[]
}

export type ZcodeUsagePersistedState = {
  schemaVersion: number
  worktreeFingerprint: string | null
  processedDatabases: ZcodeUsagePersistedDatabase[]
  sessions: ZcodeUsageSession[]
  dailyAggregates: ZcodeUsageDailyAggregate[]
  scanState: {
    enabled: boolean
    lastScanStartedAt: number | null
    lastScanCompletedAt: number | null
    lastScanError: string | null
  }
}

export type ZcodeUsageParsedEvent = {
  sessionId: string
  timestamp: string
  model: string | null
  cwd: string | null
  inputTokens: number
  cachedInputTokens: number
  cacheReadInputTokens: number
  cacheWriteInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

export type ZcodeUsageAttributedEvent = ZcodeUsageParsedEvent & {
  day: string
  projectKey: string
  projectLabel: string
  repoId: string | null
  worktreeId: string | null
}
