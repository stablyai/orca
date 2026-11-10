import { PI_USAGE_SCHEMA_VERSION } from './pi-usage-provider'
import { normalizePiUsagePersistedFiles } from './persisted-file-normalization'
import type { PiUsagePersistedState } from './types'

export function getDefaultPiUsageState(): PiUsagePersistedState {
  return {
    schemaVersion: PI_USAGE_SCHEMA_VERSION,
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

export function normalizePiUsageState(state: PiUsagePersistedState): PiUsagePersistedState {
  // Rescan incompatible caches while preserving the user's opt-in.
  if (state.schemaVersion !== PI_USAGE_SCHEMA_VERSION) {
    const defaults = getDefaultPiUsageState()
    return {
      ...defaults,
      scanState: { ...defaults.scanState, enabled: state.scanState?.enabled ?? false }
    }
  }
  return {
    ...state,
    processedFiles: normalizePiUsagePersistedFiles(state.processedFiles),
    sessions: state.sessions ?? [],
    dailyAggregates: state.dailyAggregates ?? []
  }
}
