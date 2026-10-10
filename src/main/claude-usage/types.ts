export type ClaudeUsageProcessedFile = {
  path: string
  mtimeMs: number
  size: number
  lineCount: number
  physicalFileId?: string | null
  ctimeMs?: number
}

export type ClaudeUsageLocationBreakdown = {
  locationKey: string
  projectLabel: string
  repoId: string | null
  worktreeId: string | null
  turnCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cacheWrite1hTokens: number
}

export type ClaudeUsageSession = {
  sessionId: string
  firstTimestamp: string
  lastTimestamp: string
  model: string | null
  lastCwd: string | null
  lastGitBranch: string | null
  primaryWorktreeId: string | null
  primaryRepoId: string | null
  turnCount: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheWriteTokens: number
  totalCacheWrite1hTokens: number
  locationBreakdown: ClaudeUsageLocationBreakdown[]
}

export type ClaudeUsageDailyAggregate = {
  day: string
  model: string | null
  projectKey: string
  projectLabel: string
  repoId: string | null
  worktreeId: string | null
  turnCount: number
  zeroCacheReadTurnCount: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cacheWrite1hTokens: number
}

export type ClaudeUsagePersistedState = {
  schemaVersion: number
  usageIntegrity?: string
  worktreeFingerprint: string | null
  processedFiles: ClaudeUsagePersistedFile[]
  sessions: ClaudeUsageSession[]
  dailyAggregates: ClaudeUsageDailyAggregate[]
  scanState: {
    enabled: boolean
    lastScanStartedAt: number | null
    lastScanCompletedAt: number | null
    lastScanError: string | null
  }
}

export type ClaudeUsagePersistedFile = ClaudeUsageProcessedFile & {
  sessions: ClaudeUsageSession[]
  dailyAggregates: ClaudeUsageDailyAggregate[]
  /** Dedupe keys (message.id:requestId) this file counted. Forked/resumed
   *  sessions copy earlier turns into new files; ownership keeps each turn
   *  counted by exactly one cached file across incremental scans. */
  ownedDedupeKeys: string[]
  /** True when this file saw turns already claimed by another file. When that
   *  owner disappears, only deferred files need reparse to reclaim — not the
   *  entire transcript corpus. */
  hasDeferredClaims: boolean
  parseResumeState?: ClaudeUsageParseResumeState | null
}

export type ClaudeUsageParsedTurn = {
  sessionId: string
  timestamp: string
  model: string | null
  cwd: string | null
  gitBranch: string | null
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** 1-hour-TTL subset of `cacheWriteTokens`; billed at 2x base input. */
  cacheWrite1hTokens: number
}

export type ClaudeUsageAttributedTurn = ClaudeUsageParsedTurn & {
  day: string
  projectKey: string
  projectLabel: string
  repoId: string | null
  worktreeId: string | null
}
import type { JsonlFileCheckpoint } from '../usage/jsonl-file-checkpoint'

export type ClaudeUsageTokenTotals = Pick<
  ClaudeUsageParsedTurn,
  'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'cacheWrite1hTokens'
>

export type ClaudeUsageTurnProjection = {
  sessionId: string
  day: string
  model: string | null
  projectKey: string
}

export type ClaudeUsageTokenMaxima = [
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
  cacheWriteTokens: number,
  cacheWrite1hTokens: number,
  projectionIndex: number | null
]

export type ClaudeUsageParseResumeState = JsonlFileCheckpoint & {
  lineCount: number
  ownedTokenMaxima: ClaudeUsageTokenMaxima[]
  projections: ClaudeUsageTurnProjection[]
  encounterOrder: { sessionId: string; projectKeys: string[] }[]
  projectionIntegrity?: string
}
