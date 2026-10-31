import { ZCODE_USAGE_SCHEMA_VERSION } from './zcode-usage-provider'
import {
  normalizeZcodeUsageDailyAggregates,
  normalizeZcodeUsagePersistedDatabases,
  normalizeZcodeUsageSessions
} from './persisted-database-normalization'
import type { ZcodeUsagePersistedState } from './types'

export function getDefaultZcodeUsageState(): ZcodeUsagePersistedState {
  return {
    schemaVersion: ZCODE_USAGE_SCHEMA_VERSION,
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

export function normalizeZcodeUsageState(
  state: ZcodeUsagePersistedState
): ZcodeUsagePersistedState {
  // Why: a cache from another schema cannot be trusted; rescan but keep the opt-in.
  if (state.schemaVersion !== ZCODE_USAGE_SCHEMA_VERSION) {
    const defaults = getDefaultZcodeUsageState()
    return {
      ...defaults,
      scanState: { ...defaults.scanState, enabled: state.scanState?.enabled ?? false }
    }
  }
  return {
    ...state,
    processedDatabases: normalizeZcodeUsagePersistedDatabases(state.processedDatabases),
    sessions: normalizeZcodeUsageSessions(Array.isArray(state.sessions) ? state.sessions : []),
    dailyAggregates: normalizeZcodeUsageDailyAggregates(
      Array.isArray(state.dailyAggregates) ? state.dailyAggregates : []
    )
  }
}
