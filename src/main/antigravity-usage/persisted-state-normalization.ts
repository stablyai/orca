import { ANTIGRAVITY_USAGE_SCHEMA_VERSION } from './antigravity-usage-provider'
import { normalizeAntigravityUsagePersistedFiles } from './persisted-file-normalization'
import type { AntigravityUsagePersistedState } from './types'

export function getDefaultAntigravityUsageState(): AntigravityUsagePersistedState {
  return {
    schemaVersion: ANTIGRAVITY_USAGE_SCHEMA_VERSION,
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

export function normalizeAntigravityUsageState(
  state: AntigravityUsagePersistedState
): AntigravityUsagePersistedState {
  if (state.schemaVersion !== ANTIGRAVITY_USAGE_SCHEMA_VERSION) {
    const defaults = getDefaultAntigravityUsageState()
    return {
      ...defaults,
      scanState: { ...defaults.scanState, enabled: state.scanState?.enabled ?? false }
    }
  }
  return {
    ...state,
    processedFiles: normalizeAntigravityUsagePersistedFiles(state.processedFiles),
    sessions: state.sessions ?? [],
    dailyAggregates: state.dailyAggregates ?? []
  }
}
