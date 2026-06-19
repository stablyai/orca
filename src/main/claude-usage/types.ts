export type ClaudeUsageProcessedFile = {
  path: string
  mtimeMs: number
  size: number
  lineCount: number
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
}

export type ClaudeUsagePersistedState = {
  schemaVersion: number
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
}

export type ClaudeUsageAttributedTurn = ClaudeUsageParsedTurn & {
  day: string
  projectKey: string
  projectLabel: string
  repoId: string | null
  worktreeId: string | null
}
