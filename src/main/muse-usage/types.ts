import type {
  UsageDailyAggregate,
  UsageLocationBreakdown,
  UsageLocationModelBreakdown,
  UsageModelBreakdown,
  UsageSession
} from '../usage/usage-rollup-records'

/** Muse logs carry no price, so the shared rollups get no extra metric. */
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
  /** Event keys this file counted, so a record copied into another session log counts once. */
  ownedEventKeys: string[]
  /** True when this file skipped events another file owned; only these reparse when an owner vanishes. */
  hasDeferredClaims: boolean
  /** Workspace the log resolved to; subagent logs record none and inherit their parent's. */
  sessionCwd: string | null
  /** Parent cwd a subagent log was parsed with; a change means its attribution is stale. */
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
