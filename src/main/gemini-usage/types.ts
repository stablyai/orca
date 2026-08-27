export type GeminiUsageProcessedFile = {
  path: string
  mtimeMs: number
  size: number
}

export type GeminiUsageLocationBreakdown = {
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
  estimatedCostUsd: number | null
}

export type GeminiUsageModelBreakdown = {
  modelKey: string
  modelLabel: string
  hasInferredPricing: boolean
  estimatedCostUsd: number | null
  eventCount: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

export type GeminiUsageLocationModelBreakdown = {
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
  estimatedCostUsd: number | null
}

export type GeminiUsageSession = {
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
  estimatedCostUsd: number | null
  locationBreakdown: GeminiUsageLocationBreakdown[]
  modelBreakdown: GeminiUsageModelBreakdown[]
  locationModelBreakdown: GeminiUsageLocationModelBreakdown[]
}

export type GeminiUsageDailyAggregate = {
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
  estimatedCostUsd: number | null
}

export type GeminiUsagePersistedFile = GeminiUsageProcessedFile & {
  sessions: GeminiUsageSession[]
  dailyAggregates: GeminiUsageDailyAggregate[]
  ownedEventKeys: string[]
  hasDeferredClaims: boolean
}

export type GeminiUsagePersistedState = {
  schemaVersion: number
  worktreeFingerprint: string | null
  processedFiles: GeminiUsagePersistedFile[]
  sessions: GeminiUsageSession[]
  dailyAggregates: GeminiUsageDailyAggregate[]
  scanState: {
    enabled: boolean
    lastScanStartedAt: number | null
    lastScanCompletedAt: number | null
    lastScanError: string | null
  }
}

export type GeminiUsageParsedEvent = {
  sessionId: string
  timestamp: string
  eventKey: string
  model: string | null
  cwd: string | null
  hasInferredPricing: boolean
  estimatedCostUsd: number | null
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

export type GeminiUsageAttributedEvent = GeminiUsageParsedEvent & {
  day: string
  projectKey: string
  projectLabel: string
  repoId: string | null
  worktreeId: string | null
}
