import type {
  UsageDailyAggregate,
  UsageLocationBreakdown,
  UsageLocationModelBreakdown,
  UsageModelBreakdown,
  UsageSession
} from '../usage/rollups/usage-rollup-records'

// Antigravity transcripts record token counts without billing prices.
export type AntigravityUsageMetric = Record<never, never>

export type AntigravityUsageLocationBreakdown = UsageLocationBreakdown<AntigravityUsageMetric>
export type AntigravityUsageModelBreakdown = UsageModelBreakdown<AntigravityUsageMetric>
export type AntigravityUsageLocationModelBreakdown =
  UsageLocationModelBreakdown<AntigravityUsageMetric>
export type AntigravityUsageSession = UsageSession<AntigravityUsageMetric>
export type AntigravityUsageDailyAggregate = UsageDailyAggregate<AntigravityUsageMetric>

export type AntigravityOpeningPrompt = {
  hash: string
  timestamp: string
}

export type AntigravityUsageProcessedFile = {
  path: string
  mtimeMs: number
  size: number
}

export type AntigravityUsagePersistedFile = AntigravityUsageProcessedFile & {
  conversationId: string
  effectiveSessionId: string
  effectiveCwd: string | null
  openingPrompt: AntigravityOpeningPrompt | null
  childConversationIds: string[]
  sessions: AntigravityUsageSession[]
  dailyAggregates: AntigravityUsageDailyAggregate[]
  /** Prevent copied brain trees from double-counting identical conversation steps. */
  ownedEventKeys: string[]
  /** Reparse deferred files when their event owner disappears. */
  hasDeferredClaims: boolean
}

export type AntigravityUsagePersistedState = {
  schemaVersion: number
  worktreeFingerprint: string | null
  processedFiles: AntigravityUsagePersistedFile[]
  sessions: AntigravityUsageSession[]
  dailyAggregates: AntigravityUsageDailyAggregate[]
  scanState: {
    enabled: boolean
    lastScanStartedAt: number | null
    lastScanCompletedAt: number | null
    lastScanError: string | null
  }
}

export type AntigravityUsageParsedStep = {
  timestamp: string
  eventKey: string
  model: string | null
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

export type AntigravityUsageParsedEvent = AntigravityUsageParsedStep & {
  sessionId: string
  cwd: string | null
}

export type AntigravityUsageAttributedEvent = AntigravityUsageParsedEvent & {
  day: string
  projectKey: string
  projectLabel: string
  repoId: string | null
  worktreeId: string | null
}
