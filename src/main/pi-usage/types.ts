import type {
  UsageDailyAggregate,
  UsageLocationBreakdown,
  UsageLocationModelBreakdown,
  UsageModelBreakdown,
  UsageSession
} from '../usage/usage-rollup-records'

// Pi prices each response from the user's model config and records the result.
export type PiUsageMetric = { estimatedCostUsd: number | null }

export type PiUsageLocationBreakdown = UsageLocationBreakdown<PiUsageMetric>
export type PiUsageModelBreakdown = UsageModelBreakdown<PiUsageMetric>
export type PiUsageLocationModelBreakdown = UsageLocationModelBreakdown<PiUsageMetric>
export type PiUsageSession = UsageSession<PiUsageMetric>
export type PiUsageDailyAggregate = UsageDailyAggregate<PiUsageMetric>

export type PiUsageProcessedFile = {
  path: string
  mtimeMs: number
  size: number
}

export type PiUsagePersistedFile = PiUsageProcessedFile & {
  sessions: PiUsageSession[]
  dailyAggregates: PiUsageDailyAggregate[]
  /** Forked sessions copy their parent entries; count each response once. */
  ownedEventKeys: string[]
  /** Reparse deferred files when their event owner disappears. */
  hasDeferredClaims: boolean
}

export type PiUsagePersistedState = {
  schemaVersion: number
  worktreeFingerprint: string | null
  processedFiles: PiUsagePersistedFile[]
  sessions: PiUsageSession[]
  dailyAggregates: PiUsageDailyAggregate[]
  scanState: {
    enabled: boolean
    lastScanStartedAt: number | null
    lastScanCompletedAt: number | null
    lastScanError: string | null
  }
}

export type PiUsageParsedEvent = {
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
  estimatedCostUsd: number | null
}

export type PiUsageAttributedEvent = PiUsageParsedEvent & {
  day: string
  projectKey: string
  projectLabel: string
  repoId: string | null
  worktreeId: string | null
}
