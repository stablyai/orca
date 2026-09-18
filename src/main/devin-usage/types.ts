import type { SessionSidecarObservation } from '../ai-vault/session-sidecar-stat'

export type DevinUsageProcessedFile = {
  path: string
  mtimeMs: number
  size: number
}

export type DevinUsageLocationBreakdown = {
  locationKey: string
  projectLabel: string
  repoId: string | null
  worktreeId: string | null
  eventCount: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
  estimatedCostUsd: number | null
}

export type DevinUsageModelBreakdown = {
  modelKey: string
  modelLabel: string
  estimatedCostUsd: number | null
  eventCount: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

export type DevinUsageLocationModelBreakdown = {
  locationKey: string
  modelKey: string
  modelLabel: string
  repoId: string | null
  worktreeId: string | null
  eventCount: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
  estimatedCostUsd: number | null
}

export type DevinUsageSession = {
  sessionId: string
  firstTimestamp: string
  lastTimestamp: string
  primaryModel: string | null
  hasMixedModels: boolean
  primaryProjectLabel: string
  hasMixedLocations: boolean
  primaryWorktreeId: string | null
  primaryRepoId: string | null
  eventCount: number
  totalInputTokens: number
  totalCachedInputTokens: number
  totalOutputTokens: number
  totalReasoningOutputTokens: number
  totalTokens: number
  estimatedCostUsd: number | null
  locationBreakdown: DevinUsageLocationBreakdown[]
  modelBreakdown: DevinUsageModelBreakdown[]
  locationModelBreakdown: DevinUsageLocationModelBreakdown[]
}

export type DevinUsageDailyAggregate = {
  day: string
  model: string | null
  projectKey: string
  projectLabel: string
  repoId: string | null
  worktreeId: string | null
  eventCount: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
  estimatedCostUsd: number | null
}

export type DevinUsagePersistedFile = DevinUsageProcessedFile & {
  /** sessions.db observation the projection was built under; a db-only change
   *  (cwd edit, hide) must re-attribute even when the transcript is unchanged. */
  sessionsDb: SessionSidecarObservation
  sessions: DevinUsageSession[]
  dailyAggregates: DevinUsageDailyAggregate[]
  /** Session ids this file counted. Transcript copies carrying the same
   *  session_id would otherwise double-count across incremental scans. */
  ownedSessionIds: string[]
  /** True when this file saw a session already claimed by another file. When
   *  that owner disappears, only deferred files need reparse to reclaim. */
  hasDeferredClaims: boolean
}

export type DevinUsagePersistedState = {
  schemaVersion: number
  worktreeFingerprint: string | null
  processedFiles: DevinUsagePersistedFile[]
  sessions: DevinUsageSession[]
  dailyAggregates: DevinUsageDailyAggregate[]
  scanState: {
    enabled: boolean
    lastScanStartedAt: number | null
    lastScanCompletedAt: number | null
    lastScanError: string | null
  }
}

export type DevinUsageParsedEvent = {
  sessionId: string
  timestamp: string
  model: string | null
  cwd: string | null
  estimatedCostUsd: number | null
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

export type DevinUsageAttributedEvent = DevinUsageParsedEvent & {
  day: string
  projectKey: string
  projectLabel: string
  repoId: string | null
  worktreeId: string | null
}
