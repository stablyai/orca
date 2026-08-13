import type {
  KimiUsageAttributedEvent,
  KimiUsageDailyAggregate,
  KimiUsageLocationBreakdown,
  KimiUsageLocationModelBreakdown,
  KimiUsageModelBreakdown,
  KimiUsageSession
} from './types'

function createEmptySession(event: KimiUsageAttributedEvent): KimiUsageSession {
  return {
    sessionId: event.sessionId,
    firstTimestamp: event.timestamp,
    lastTimestamp: event.timestamp,
    primaryModel: event.model,
    hasMixedModels: false,
    primaryProjectLabel: event.projectLabel,
    hasMixedLocations: false,
    primaryWorktreeId: event.worktreeId,
    primaryRepoId: event.repoId,
    eventCount: 0,
    totalInputTokens: 0,
    totalCachedInputTokens: 0,
    totalCacheCreationTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    locationBreakdown: [],
    modelBreakdown: [],
    locationModelBreakdown: []
  }
}

function createEmptyDailyAggregate(event: KimiUsageAttributedEvent): KimiUsageDailyAggregate {
  return {
    day: event.day,
    model: event.model,
    projectKey: event.projectKey,
    projectLabel: event.projectLabel,
    repoId: event.repoId,
    worktreeId: event.worktreeId,
    eventCount: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    totalTokens: 0
  }
}

function mergeLocationBreakdown(
  target: KimiUsageLocationBreakdown[],
  event: KimiUsageAttributedEvent
): void {
  const existing = target.find((entry) => entry.locationKey === event.projectKey) ?? null
  if (existing) {
    existing.eventCount++
    existing.inputTokens += event.inputTokens
    existing.cachedInputTokens += event.cachedInputTokens
    existing.cacheCreationTokens += event.cacheCreationTokens
    existing.outputTokens += event.outputTokens
    existing.totalTokens += event.totalTokens
    return
  }
  target.push({
    locationKey: event.projectKey,
    projectLabel: event.projectLabel,
    repoId: event.repoId,
    worktreeId: event.worktreeId,
    eventCount: 1,
    inputTokens: event.inputTokens,
    cachedInputTokens: event.cachedInputTokens,
    cacheCreationTokens: event.cacheCreationTokens,
    outputTokens: event.outputTokens,
    totalTokens: event.totalTokens
  })
}

function mergeModelBreakdown(
  target: KimiUsageModelBreakdown[],
  event: KimiUsageAttributedEvent
): void {
  const key = event.model ?? 'unknown'
  const existing = target.find((entry) => entry.modelKey === key) ?? null
  if (existing) {
    existing.eventCount++
    existing.inputTokens += event.inputTokens
    existing.cachedInputTokens += event.cachedInputTokens
    existing.cacheCreationTokens += event.cacheCreationTokens
    existing.outputTokens += event.outputTokens
    existing.totalTokens += event.totalTokens
    return
  }
  target.push({
    modelKey: key,
    modelLabel: event.model ?? 'Unknown model',
    eventCount: 1,
    inputTokens: event.inputTokens,
    cachedInputTokens: event.cachedInputTokens,
    cacheCreationTokens: event.cacheCreationTokens,
    outputTokens: event.outputTokens,
    totalTokens: event.totalTokens
  })
}

function mergeLocationModelBreakdown(
  target: KimiUsageLocationModelBreakdown[],
  event: KimiUsageAttributedEvent
): void {
  const modelKey = event.model ?? 'unknown'
  const existing =
    target.find((entry) => entry.locationKey === event.projectKey && entry.modelKey === modelKey) ??
    null
  if (existing) {
    existing.eventCount++
    existing.inputTokens += event.inputTokens
    existing.cachedInputTokens += event.cachedInputTokens
    existing.cacheCreationTokens += event.cacheCreationTokens
    existing.outputTokens += event.outputTokens
    existing.totalTokens += event.totalTokens
    return
  }
  target.push({
    locationKey: event.projectKey,
    modelKey,
    modelLabel: event.model ?? 'Unknown model',
    repoId: event.repoId,
    worktreeId: event.worktreeId,
    eventCount: 1,
    inputTokens: event.inputTokens,
    cachedInputTokens: event.cachedInputTokens,
    cacheCreationTokens: event.cacheCreationTokens,
    outputTokens: event.outputTokens,
    totalTokens: event.totalTokens
  })
}

export function aggregateKimiUsage(events: KimiUsageAttributedEvent[]): {
  sessions: KimiUsageSession[]
  dailyAggregates: KimiUsageDailyAggregate[]
} {
  const sessionsById = new Map<string, KimiUsageSession>()
  const dailyByKey = new Map<string, KimiUsageDailyAggregate>()
  for (const event of events) {
    const session = sessionsById.get(event.sessionId) ?? createEmptySession(event)
    if (!sessionsById.has(event.sessionId)) {
      sessionsById.set(event.sessionId, session)
    }
    if (event.timestamp < session.firstTimestamp) {
      session.firstTimestamp = event.timestamp
    }
    if (event.timestamp >= session.lastTimestamp) {
      session.lastTimestamp = event.timestamp
    }
    session.eventCount++
    session.totalInputTokens += event.inputTokens
    session.totalCachedInputTokens += event.cachedInputTokens
    session.totalCacheCreationTokens += event.cacheCreationTokens
    session.totalOutputTokens += event.outputTokens
    session.totalTokens += event.totalTokens
    mergeLocationBreakdown(session.locationBreakdown, event)
    mergeModelBreakdown(session.modelBreakdown, event)
    mergeLocationModelBreakdown(session.locationModelBreakdown, event)

    const dailyKey = [event.day, event.model ?? 'unknown', event.projectKey].join('::')
    const daily = dailyByKey.get(dailyKey) ?? createEmptyDailyAggregate(event)
    if (!dailyByKey.has(dailyKey)) {
      dailyByKey.set(dailyKey, daily)
    }
    daily.eventCount++
    daily.inputTokens += event.inputTokens
    daily.cachedInputTokens += event.cachedInputTokens
    daily.cacheCreationTokens += event.cacheCreationTokens
    daily.outputTokens += event.outputTokens
    daily.totalTokens += event.totalTokens
  }
  return {
    sessions: finalizeSessions(sessionsById),
    dailyAggregates: sortDailyAggregates([...dailyByKey.values()])
  }
}

export function finalizeSessions(sessionsById: Map<string, KimiUsageSession>): KimiUsageSession[] {
  for (const session of sessionsById.values()) {
    session.locationBreakdown.sort((left, right) => right.totalTokens - left.totalTokens)
    session.modelBreakdown.sort((left, right) => right.totalTokens - left.totalTokens)
    const primaryLocation = session.locationBreakdown[0] ?? null
    const primaryModel = session.modelBreakdown[0] ?? null
    session.primaryProjectLabel =
      session.locationBreakdown.length <= 1
        ? (primaryLocation?.projectLabel ?? 'Unknown location')
        : 'Multiple locations'
    session.hasMixedLocations = session.locationBreakdown.length > 1
    session.primaryWorktreeId = primaryLocation?.worktreeId ?? null
    session.primaryRepoId = primaryLocation?.repoId ?? null
    session.primaryModel =
      session.modelBreakdown.length <= 1 ? (primaryModel?.modelLabel ?? null) : 'Mixed models'
    session.hasMixedModels = session.modelBreakdown.length > 1
  }
  return [...sessionsById.values()].sort((left, right) =>
    right.lastTimestamp.localeCompare(left.lastTimestamp)
  )
}

export function mergeDailyAggregates(
  target: Map<string, KimiUsageDailyAggregate>,
  dailyAggregates: KimiUsageDailyAggregate[]
): void {
  for (const aggregate of dailyAggregates) {
    const key = [aggregate.day, aggregate.model ?? 'unknown', aggregate.projectKey].join('::')
    const existing = target.get(key)
    if (!existing) {
      target.set(key, { ...aggregate })
      continue
    }
    existing.eventCount += aggregate.eventCount
    existing.inputTokens += aggregate.inputTokens
    existing.cachedInputTokens += aggregate.cachedInputTokens
    existing.cacheCreationTokens += aggregate.cacheCreationTokens
    existing.outputTokens += aggregate.outputTokens
    existing.totalTokens += aggregate.totalTokens
  }
}

export function sortDailyAggregates(
  dailyAggregates: KimiUsageDailyAggregate[]
): KimiUsageDailyAggregate[] {
  return dailyAggregates.sort((left, right) =>
    left.day === right.day
      ? left.projectLabel.localeCompare(right.projectLabel)
      : left.day.localeCompare(right.day)
  )
}
