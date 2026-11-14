import { MISTRAL_VIBE_USAGE_SCHEMA_VERSION } from './mistral-vibe-usage-provider'
import { normalizeMistralVibeUsagePersistedFiles } from './persisted-file-normalization'
import type { MistralVibeUsagePersistedState } from './types'

export function getDefaultMistralVibeUsageState(): MistralVibeUsagePersistedState {
  return {
    schemaVersion: MISTRAL_VIBE_USAGE_SCHEMA_VERSION,
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

export function normalizeMistralVibeUsageState(
  state: MistralVibeUsagePersistedState
): MistralVibeUsagePersistedState {
  // Rescan incompatible caches while preserving the user's opt-in.
  if (state.schemaVersion !== MISTRAL_VIBE_USAGE_SCHEMA_VERSION) {
    const defaults = getDefaultMistralVibeUsageState()
    return {
      ...defaults,
      scanState: { ...defaults.scanState, enabled: state.scanState?.enabled ?? false }
    }
  }
  return {
    ...state,
    processedFiles: normalizeMistralVibeUsagePersistedFiles(state.processedFiles),
    sessions: state.sessions ?? [],
    dailyAggregates: state.dailyAggregates ?? []
  }
}
