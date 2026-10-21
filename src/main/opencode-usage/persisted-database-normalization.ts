import type {
  OpenCodeUsageDailyAggregate,
  OpenCodeUsagePersistedDatabase,
  OpenCodeUsagePersistedState
} from './types'

/** Fills cost fields older OpenCode caches never wrote. Electron-free: the scan worker runs it too. */
export function normalizeOpenCodeUsagePersistedDatabases(
  databases: OpenCodeUsagePersistedDatabase[] | undefined
): OpenCodeUsagePersistedDatabase[] {
  return (databases ?? []).map((database) => ({
    ...database,
    sessions: (database.sessions ?? []).map(normalizeSessionCost),
    dailyAggregates: (database.dailyAggregates ?? []).map(normalizeDailyAggregateCost)
  }))
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
