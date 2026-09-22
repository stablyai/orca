import type { DevinUsageDailyAggregate, DevinUsagePersistedState } from './types'
import { DEVIN_USAGE_SCHEMA_VERSION } from './devin-usage-provider'

const SCHEMA_VERSION = DEVIN_USAGE_SCHEMA_VERSION

export function getDefaultState(): DevinUsagePersistedState {
  return {
    schemaVersion: SCHEMA_VERSION,
    worktreeFingerprint: null,
    processedFiles: [],
    sessions: [],
    dailyAggregates: [],
    scanState: {
      enabled: false,
      lastScanStartedAt: null,
      lastScanCompletedAt: null,
      lastScanError: null
    }
  }
}

export function normalizePersistedState(state: DevinUsagePersistedState): DevinUsagePersistedState {
  if (state.schemaVersion !== SCHEMA_VERSION) {
    return getDefaultState()
  }
  return {
    ...state,
    processedFiles: (state.processedFiles ?? []).map((file) => ({
      ...file,
      sessions: (file.sessions ?? []).map(normalizeSessionCost),
      dailyAggregates: (file.dailyAggregates ?? []).map(normalizeDailyAggregateCost)
    })),
    sessions: state.sessions.map(normalizeSessionCost),
    dailyAggregates: state.dailyAggregates.map(normalizeDailyAggregateCost)
  }
}

function normalizeDailyAggregateCost(entry: DevinUsageDailyAggregate): DevinUsageDailyAggregate {
  return {
    ...entry,
    estimatedCostUsd: entry.estimatedCostUsd ?? null
  }
}

function normalizeSessionCost(
  session: DevinUsagePersistedState['sessions'][number]
): DevinUsagePersistedState['sessions'][number] {
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
