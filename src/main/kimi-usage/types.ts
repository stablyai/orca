export type KimiUsageProcessedFile = {
  path: string
  mtimeMs: number
  size: number
}

export type KimiUsageLocationBreakdown = {
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

export type KimiUsageModelBreakdown = {
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

export type KimiUsageLocationModelBreakdown = {
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

export type KimiUsageSession = {
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
  locationBreakdown: KimiUsageLocationBreakdown[]
  modelBreakdown: KimiUsageModelBreakdown[]
  locationModelBreakdown: KimiUsageLocationModelBreakdown[]
}

export type KimiUsageDailyAggregate = {
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

export type KimiUsagePersistedFile = KimiUsageProcessedFile & {
  sessions: KimiUsageSession[]
  dailyAggregates: KimiUsageDailyAggregate[]
}

export type KimiUsagePersistedState = {
  schemaVersion: number
  worktreeFingerprint: string | null
  processedFiles: KimiUsagePersistedFile[]
  sessions: KimiUsageSession[]
  dailyAggregates: KimiUsageDailyAggregate[]
  scanState: {
    enabled: boolean
    lastScanStartedAt: number | null
    lastScanCompletedAt: number | null
    lastScanError: string | null
  }
}

export type KimiUsageParsedEvent = {
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

export type KimiUsageAttributedEvent = KimiUsageParsedEvent & {
  day: string
  projectKey: string
  projectLabel: string
  repoId: string | null
  worktreeId: string | null
}
