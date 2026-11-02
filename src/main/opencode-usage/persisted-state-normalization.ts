import type { OpenCodeUsagePersistedState } from './types'
import { OPENCODE_USAGE_SCHEMA_VERSION } from './opencode-usage-provider'
import {
  normalizeDailyAggregateCost,
  normalizeOpenCodeUsagePersistedDatabases,
  normalizeSessionCost
} from './persisted-database-normalization'

const SCHEMA_VERSION = OPENCODE_USAGE_SCHEMA_VERSION

export function getDefaultState(): OpenCodeUsagePersistedState {
  return {
    schemaVersion: SCHEMA_VERSION,
    worktreeFingerprint: null,
    processedDatabases: [],
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

export function normalizePersistedState(
  state: OpenCodeUsagePersistedState
): OpenCodeUsagePersistedState {
  if (state.schemaVersion !== SCHEMA_VERSION) {
    const defaults = getDefaultState()
    return {
      ...defaults,
      scanState: { ...defaults.scanState, enabled: state.scanState?.enabled ?? false }
    }
  }
  return {
    ...state,
    processedDatabases: normalizeOpenCodeUsagePersistedDatabases(state.processedDatabases),
    sessions: state.sessions.map(normalizeSessionCost),
    dailyAggregates: state.dailyAggregates.map(normalizeDailyAggregateCost)
  }
}
