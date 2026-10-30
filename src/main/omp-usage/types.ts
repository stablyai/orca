/** Flat per-session projection; omp records one usage counter set per assistant message and precomputes cost. */
export type OmpUsageSession = {
  sessionId: string
  startedAt: string
  endedAt?: string
  cwd: string
  model: string
  provider: string
  repoId?: string
  worktreeId?: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  totalTokens: number
  costUsd: number
}

export type OmpUsageDailyAggregate = {
  day: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  totalTokens: number
  costUsd: number
}

export type OmpUsageProcessedFile = {
  path: string
  mtimeMs: number
  size: number
}

/**
 * Byte-offset resume state; omp appends session records, so a verified checkpoint skips the parsed
 * prefix while carrying the session and model context that later lines depend on.
 */
export type OmpUsageParseResumeState = {
  /** Offset after the last newline; a partial trailing row is read again. */
  parsedBytes: number
  /** Digest before parsedBytes; headDigest also detects rewrites that preserve this boundary. */
  boundaryDigest: string
  /** Detects leading-record rewrites that preserve the boundary window. */
  headDigest: string
  /** dev:ino or null; inode reuse means this alone cannot detect rotation. */
  physicalFileId: string | null
  sessionId: string
  sessionStartedAt: string | null
  cwd: string | null
  currentModel: string | null
  currentProvider: string | null
}

export type OmpUsagePersistedFile = OmpUsageProcessedFile & {
  sessions: OmpUsageSession[]
  dailyAggregates: OmpUsageDailyAggregate[]
  /** Absent in older caches and on tiny files; null disables parsing from a saved checkpoint. */
  parseResumeState?: OmpUsageParseResumeState | null
}

export type OmpUsagePersistedState = {
  schemaVersion: number
  worktreeFingerprint: string | null
  processedFiles: OmpUsagePersistedFile[]
  sessions: OmpUsageSession[]
  dailyAggregates: OmpUsageDailyAggregate[]
  scanState: {
    enabled: boolean
    lastScanStartedAt: number | null
    lastScanCompletedAt: number | null
    lastScanError: string | null
  }
}
