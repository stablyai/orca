import type {
  ZcodeUsageDailyAggregate,
  ZcodeUsagePersistedDatabase,
  ZcodeUsageSession
} from './types'

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function isObjectArray(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isObject)
}

function isZcodeUsageSession(value: unknown): value is ZcodeUsageSession {
  return (
    isObject(value) &&
    isObjectArray(value.locationBreakdown) &&
    isObjectArray(value.modelBreakdown) &&
    isObjectArray(value.locationModelBreakdown)
  )
}

function isZcodeUsageDailyAggregate(value: unknown): value is ZcodeUsageDailyAggregate {
  return isObject(value)
}

export function normalizeZcodeUsageSessions(sessions: unknown): ZcodeUsageSession[] {
  if (!Array.isArray(sessions)) {
    return []
  }
  return sessions.filter(isZcodeUsageSession).map((session) => ({
    ...session,
    cacheReadInputTokens: session.cacheReadInputTokens ?? 0,
    cacheWriteInputTokens: session.cacheWriteInputTokens ?? 0,
    locationBreakdown: session.locationBreakdown.map((entry) => ({
      ...entry,
      cacheReadInputTokens: entry.cacheReadInputTokens ?? 0,
      cacheWriteInputTokens: entry.cacheWriteInputTokens ?? 0
    })),
    modelBreakdown: session.modelBreakdown.map((entry) => ({
      ...entry,
      cacheReadInputTokens: entry.cacheReadInputTokens ?? 0,
      cacheWriteInputTokens: entry.cacheWriteInputTokens ?? 0
    })),
    locationModelBreakdown: session.locationModelBreakdown.map((entry) => ({
      ...entry,
      cacheReadInputTokens: entry.cacheReadInputTokens ?? 0,
      cacheWriteInputTokens: entry.cacheWriteInputTokens ?? 0
    }))
  }))
}

export function normalizeZcodeUsageDailyAggregates(
  dailyAggregates: unknown
): ZcodeUsageDailyAggregate[] {
  if (!Array.isArray(dailyAggregates)) {
    return []
  }
  return dailyAggregates.filter(isZcodeUsageDailyAggregate).map((aggregate) => ({
    ...aggregate,
    cacheReadInputTokens: aggregate.cacheReadInputTokens ?? 0,
    cacheWriteInputTokens: aggregate.cacheWriteInputTokens ?? 0
  }))
}

export function normalizeZcodeUsagePersistedDatabases(
  databases: ZcodeUsagePersistedDatabase[] | undefined
): ZcodeUsagePersistedDatabase[] {
  return (databases ?? [])
    .filter(
      (database) =>
        isObject(database) &&
        Array.isArray(database.sessions) &&
        database.sessions.every(isZcodeUsageSession) &&
        Array.isArray(database.dailyAggregates) &&
        database.dailyAggregates.every(isZcodeUsageDailyAggregate)
    )
    .map((database) => ({
      ...database,
      sessions: normalizeZcodeUsageSessions(database.sessions),
      dailyAggregates: normalizeZcodeUsageDailyAggregates(database.dailyAggregates)
    }))
}
