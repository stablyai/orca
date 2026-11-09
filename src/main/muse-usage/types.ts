import type {
  UsageDailyAggregate,
  UsageLocationBreakdown,
  UsageLocationModelBreakdown,
  UsageModelBreakdown,
  UsageSession
} from '../usage/usage-rollup-records'

// Muse supplies no prices for rollups.
export type MuseUsageMetric = Record<never, never>

export type MuseUsageLocationBreakdown = UsageLocationBreakdown<MuseUsageMetric>
export type MuseUsageModelBreakdown = UsageModelBreakdown<MuseUsageMetric>
export type MuseUsageLocationModelBreakdown = UsageLocationModelBreakdown<MuseUsageMetric>
export type MuseUsageSession = UsageSession<MuseUsageMetric>
export type MuseUsageDailyAggregate = UsageDailyAggregate<MuseUsageMetric>

export type MuseUsageProcessedFile = {
  path: string
  mtimeMs: number
  size: number
}

export type MuseUsagePersistedFile = MuseUsageProcessedFile & {
  sessions: MuseUsageSession[]
  dailyAggregates: MuseUsageDailyAggregate[]
  /** Prevent copied events from counting in multiple logs. */
  ownedEventKeys: string[]
  /** Reparse deferred files when their event owner disappears. */
  hasDeferredClaims: boolean
  /** Subagent logs inherit parent workspace attribution. */
  sessionCwd: string | null
  /** Reparse when inherited parent cwd changes. */
  inheritedCwd: string | null
}

export type MuseUsagePersistedState = {
  schemaVersion: number
  worktreeFingerprint: string | null
  processedFiles: MuseUsagePersistedFile[]
  sessions: MuseUsageSession[]
  dailyAggregates: MuseUsageDailyAggregate[]
  scanState: {
    enabled: boolean
    lastScanStartedAt: number | null
    lastScanCompletedAt: number | null
    lastScanError: string | null
  }
}

export type MuseUsageParsedEvent = {
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

export type MuseUsageAttributedEvent = MuseUsageParsedEvent & {
  day: string
  projectKey: string
  projectLabel: string
  repoId: string | null
  worktreeId: string | null
}
