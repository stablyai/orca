import type {
  OpenCodeUsageDailyAggregate,
  OpenCodeUsagePersistedDatabase,
  OpenCodeUsagePersistedState
} from './types'

/** Normalize legacy cache cost fields without Electron so scan workers can use it. */
export function normalizeOpenCodeUsagePersistedDatabases(
  databases: OpenCodeUsagePersistedDatabase[] | undefined
): OpenCodeUsagePersistedDatabase[] {
  return (databases ?? []).map((database) =>
    // A record missing a projection must be reread, not reused as zero usage; keep its claims so a deleted owner still frees them.
    Array.isArray(database.sessions) && Array.isArray(database.dailyAggregates)
      ? {
          ...database,
          sessions: database.sessions.map(normalizeSessionCost),
          dailyAggregates: database.dailyAggregates.map(normalizeDailyAggregateCost)
        }
      : { ...database, sessions: [], dailyAggregates: [], mtimeMs: -1, size: -1 }
  )
}

export function normalizeDailyAggregateCost(
  entry: OpenCodeUsageDailyAggregate
): OpenCodeUsageDailyAggregate {
  return {
    ...entry,
    estimatedCostUsd: entry.estimatedCostUsd ?? null
  }
}

export function normalizeSessionCost(
  session: OpenCodeUsagePersistedState['sessions'][number]
): OpenCodeUsagePersistedState['sessions'][number] {
  return {
    ...session,
    estimatedCostUsd: session.estimatedCostUsd ?? null,
    locationBreakdown: (session.locationBreakdown ?? []).map((entry) => ({
      ...entry,
      estimatedCostUsd: entry.estimatedCostUsd ?? null
    })),
    modelBreakdown: (session.modelBreakdown ?? []).map((entry) => ({
      ...entry,
      estimatedCostUsd: entry.estimatedCostUsd ?? null
    })),
    locationModelBreakdown: (session.locationModelBreakdown ?? []).map((entry) => ({
      ...entry,
      estimatedCostUsd: entry.estimatedCostUsd ?? null
    }))
  }
}
