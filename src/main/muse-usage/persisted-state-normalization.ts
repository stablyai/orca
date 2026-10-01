import { MUSE_USAGE_SCHEMA_VERSION } from './muse-usage-provider'
import type { MuseUsagePersistedState } from './types'

export function getDefaultMuseUsageState(): MuseUsagePersistedState {
  return {
    schemaVersion: MUSE_USAGE_SCHEMA_VERSION,
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

export function normalizeMuseUsageState(state: MuseUsagePersistedState): MuseUsagePersistedState {
  // Why: a cache from another schema cannot be trusted; rescan but keep the opt-in.
  if (state.schemaVersion !== MUSE_USAGE_SCHEMA_VERSION) {
    const defaults = getDefaultMuseUsageState()
    return {
      ...defaults,
      scanState: { ...defaults.scanState, enabled: state.scanState?.enabled ?? false }
    }
  }
  return {
    ...state,
    processedFiles: (state.processedFiles ?? []).map((file) => ({
      ...file,
      sessions: file.sessions ?? [],
      dailyAggregates: file.dailyAggregates ?? [],
      ownedEventKeys: file.ownedEventKeys ?? [],
      hasDeferredClaims: file.hasDeferredClaims ?? true,
      sessionCwd: file.sessionCwd ?? null,
      inheritedCwd: file.inheritedCwd ?? null
    })),
    sessions: state.sessions ?? [],
    dailyAggregates: state.dailyAggregates ?? []
  }
}
