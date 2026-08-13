export type KimiUsageProcessedFile = {
  path: string
  mtimeMs: number
  size: number
  wirePath: string | null
  wireMtimeMs: number | null
  wireSize: number | null
}

export type KimiUsageLocationBreakdown = {
  locationKey: string
  projectLabel: string
  repoId: string | null
  worktreeId: string | null
  eventCount: number
  inputTokens: number
  cachedInputTokens: number
  cacheCreationTokens: number
  outputTokens: number
  totalTokens: number
}

export type KimiUsageModelBreakdown = {
  modelKey: string
  modelLabel: string
  eventCount: number
  inputTokens: number
  cachedInputTokens: number
  cacheCreationTokens: number
  outputTokens: number
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
  cacheCreationTokens: number
  outputTokens: number
  totalTokens: number
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
  totalCacheCreationTokens: number
  totalOutputTokens: number
  totalTokens: number
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
  cacheCreationTokens: number
  outputTokens: number
  totalTokens: number
}

export type KimiUsagePersistedFile = KimiUsageProcessedFile & {
  sessions: KimiUsageSession[]
  dailyAggregates: KimiUsageDailyAggregate[]
  ownedEventKeys: string[]
  hasDeferredClaims: boolean
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
  eventKey: string
  model: string | null
  cwd: string | null
  inputTokens: number
  cachedInputTokens: number
  cacheCreationTokens: number
  outputTokens: number
  totalTokens: number
}

export type KimiUsageAttributedEvent = KimiUsageParsedEvent & {
  day: string
  projectKey: string
  projectLabel: string
  repoId: string | null
  worktreeId: string | null
}
