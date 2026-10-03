import type { CodexUsageRawUsage } from './codex-usage-token-delta'

/** Tokens from requests whose prompt exceeded LONG_CONTEXT_THRESHOLD_TOKENS — a subset of the
 *  matching totals beside them. Kept as counts so a pricing edit reprices history without a rescan. */
export type CodexLongContextTokens = {
  longContextInputTokens: number
  longContextCachedInputTokens: number
  longContextOutputTokens: number
}

export type CodexUsageProcessedFile = {
  path: string
  mtimeMs: number
  size: number
}

/** Everything needed to resume parsing a grown rollout where the last scan
 *  stopped, plus the evidence that the already-parsed prefix is still intact. */
export type CodexUsageParseResumeState = {
  /** Offset just past the last line that ended in a newline. Never the raw file
   *  size: a rollout can be observed mid-write with a partial trailing line. */
  parsedBytes: number
  /** Digest of the bytes just before `parsedBytes`. A rewrite or rotation that
   *  leaves the file at the same length still changes this, unless it left the
   *  tail of the prefix byte-identical — which is what `headDigest` covers. */
  boundaryDigest: string
  /** Digest of the bytes at the start of the parsed prefix. Catches a rewrite
   *  that replaced the leading records and kept the length and the tail. */
  headDigest: string
  /** `dev:ino`, or null where the platform does not report an inode. Not a
   *  rotation check: ext4 and overlayfs reuse the inode of a recreated path. */
  physicalFileId: string | null
  sessionId: string
  sessionCwd: string | null
  currentCwd: string | null
  currentModel: string | null
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
  sessions: CodexUsageSession[]
  dailyAggregates: CodexUsageDailyAggregate[]
  /** Digests of the event keys this file counted, packed by
   *  `packUsageEventKeyDigests`. Resumed/forked rollouts copy earlier
   *  token_count records into new files; ownership keeps each record counted
   *  by exactly one cached file across incremental scans. */
  ownedEventKeyDigests: string
  /** True when this file saw events already claimed by another file. When that
   *  owner disappears, only deferred files need reparse to reclaim — not the
   *  entire rollout corpus. */
  hasDeferredClaims: boolean
  /** Null when this file must be reparsed from byte 0 next scan. Absent on
   *  caches written before incremental resume shipped. */
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
  /** Raw-record identity (timestamp + token tuples) used to dedupe the same
   *  token_count record copied across fork/resume rollout files. Session id is
   *  omitted because forks rewrite session_meta while copying the record. */
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
  day: string
  projectKey: string
  projectLabel: string
  repoId: string | null
  worktreeId: string | null
}
