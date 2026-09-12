/**
 * Record shapes every event-based usage provider (Codex, OpenCode, future plugin sources)
 * rolls up to. Each provider carries exactly one extra metric alongside the token counters —
 * Codex tracks inferred pricing, OpenCode tracks cost — so that metric stays generic instead
 * of forcing a nullable union onto both.
 */

export type UsageAttributedEventFields = {
  sessionId: string
  timestamp: string
  model: string | null
  day: string
  projectKey: string
  projectLabel: string
  repoId: string | null
  worktreeId: string | null
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
}

export type UsageLocationBreakdown<TMetric> = {
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
} & TMetric

export type UsageModelBreakdown<TMetric> = {
  modelKey: string
  modelLabel: string
  eventCount: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  totalTokens: number
} & TMetric

export type UsageLocationModelBreakdown<TMetric> = {
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
} & TMetric

export type UsageSession<TMetric> = {
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
  locationBreakdown: UsageLocationBreakdown<TMetric>[]
  modelBreakdown: UsageModelBreakdown<TMetric>[]
  locationModelBreakdown: UsageLocationModelBreakdown<TMetric>[]
} & TMetric

export type UsageDailyAggregate<TMetric> = {
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
} & TMetric

/** How a provider seeds, reads, and combines its one extra metric. */
export type UsageMetricFold<TEvent, TMetric> = {
  empty(): TMetric
  fromEvent(event: TEvent): TMetric
  fold(target: TMetric, source: TMetric): void
}

export function usageDailyAggregateKey(record: {
  day: string
  model: string | null
  projectKey: string
}): string {
  return [record.day, record.model ?? 'unknown', record.projectKey].join('::')
}
