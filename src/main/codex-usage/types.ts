import type { CodexUsageRawUsage } from './codex-usage-token-delta'

/** Store long-context subsets as counts so pricing changes can reprice history without rescanning. */
export type CodexLongContextTokens = {
  longContextInputTokens: number
  longContextCachedInputTokens: number
  longContextOutputTokens: number
}

export type CodexUsageProcessedFile = {
  path: string
  mtimeMs: number
  size: number
  /** Absent in older caches; identifies the file that produced this projection. */
  physicalFileId?: string | null
  ctimeMs?: number
}

export type CodexUsageParseResumeState = {
  /** Offset after the last newline; partial trailing rows must be read again. */
  parsedBytes: number
  /** Digest before parsedBytes; headDigest also detects rewrites that preserve this boundary. */
  boundaryDigest: string
  /** Detects leading-record rewrites that preserve the boundary window. */
  headDigest: string
  /** dev:ino or null; inode reuse means this alone cannot detect rotation. */
  physicalFileId: string | null
  sessionId: string
  sessionCwd: string | null
  currentCwd: string | null
  currentModel: string | null
  currentTurnId?: string | null
  previousTotals: CodexUsageRawUsage | null
}

export type CodexUsageLocationBreakdown = {
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
  hasInferredPricing: boolean
} & CodexLongContextTokens

export type CodexUsageModelBreakdown = {
  modelKey: string
  modelLabel: string
  hasInferredPricing: boolean
  eventCount: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
} & CodexLongContextTokens

export type CodexUsageLocationModelBreakdown = {
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
  hasInferredPricing: boolean
} & CodexLongContextTokens

export type CodexUsageSession = {
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
  hasInferredPricing: boolean
  locationBreakdown: CodexUsageLocationBreakdown[]
  modelBreakdown: CodexUsageModelBreakdown[]
  locationModelBreakdown: CodexUsageLocationModelBreakdown[]
} & CodexLongContextTokens

export type CodexUsageDailyAggregate = {
  accountId?: string | null
  sessionId?: string
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
  hasInferredPricing: boolean
} & CodexLongContextTokens

export type CodexUsagePersistedFile = CodexUsageProcessedFile & {
  /** Aligned with ownedEventKeys; null preserves unknown and legacy ownership. */
  ownedAccountIds?: (string | null)[]
  sessions: CodexUsageSession[]
  dailyAggregates: CodexUsageDailyAggregate[]
  /** Persisted ownership prevents forked copies from counting the same usage record twice. */
  ownedEventKeys: string[]
  /** Reparse these deferred claims if another file releases their ownership. */
  hasDeferredClaims: boolean
  /** Absent in older caches; null disables parsing from a saved checkpoint. */
  parseResumeState?: CodexUsageParseResumeState | null
}

export type CodexUsagePersistedState = {
  schemaVersion: number
  worktreeFingerprint: string | null
  processedFiles: CodexUsagePersistedFile[]
  sessions: CodexUsageSession[]
  dailyAggregates: CodexUsageDailyAggregate[]
  scanState: {
    enabled: boolean
    lastScanStartedAt: number | null
    lastScanCompletedAt: number | null
    lastScanError: string | null
  }
}

export type CodexUsageParsedEvent = {
  sessionId: string
  timestamp: string
  /** Timestamp and usage tuples, excluding session IDs that forks rewrite. */
  eventKey: string
  model: string | null
  cwd: string | null
  hasInferredPricing: boolean
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
} & CodexLongContextTokens

export type CodexUsageAttributedEvent = CodexUsageParsedEvent & {
  accountId?: string | null
  day: string
  projectKey: string
  projectLabel: string
  repoId: string | null
  worktreeId: string | null
}
