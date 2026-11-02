import type { ClaudeUsagePersistedState } from './types'
import {
  hasClaudeUsageProtectedCheckpoint,
  initializePersistedClaudeUsageProjections
} from './persisted-projection-validation'
import { sealUsageCacheJson, verifyUsageCacheJson } from '../usage/usage-cache-json-integrity'

const REPORT_DOMAIN = 'claude-usage-report-v1'

function invalidateReport(state: ClaudeUsagePersistedState): ClaudeUsagePersistedState {
  return {
    ...state,
    processedFiles: [],
    sessions: [],
    dailyAggregates: [],
    scanState: {
      ...state.scanState,
      lastScanCompletedAt: null,
      lastScanError: 'Saved usage totals could not be validated. Refresh to rebuild them.'
    }
  }
}

export function serializeClaudeUsageReport(state: ClaudeUsagePersistedState): string {
  const { processedFiles: _sources, usageIntegrity: _integrity, ...report } = state
  const material = JSON.stringify(report)
  // Unsigned v6 history retains its legacy status until a source scan verifies a new generation.
  return state.schemaVersion === 6 ? material : sealUsageCacheJson(material, REPORT_DOMAIN)
}

export function parseClaudeUsageReport(
  text: string,
  parsed?: ClaudeUsagePersistedState,
  integrityVerified = false
): ClaudeUsagePersistedState | Promise<ClaudeUsagePersistedState> {
  const state: ClaudeUsagePersistedState = parsed ?? JSON.parse(text)
  try {
    if ('processedFiles' in state && !Array.isArray(state.processedFiles)) {
      return invalidateReport(state)
    }
    if (integrityVerified || verifyUsageCacheJson(text, state.usageIntegrity, REPORT_DOMAIN)) {
      if (state.schemaVersion !== 7 || (state.processedFiles?.length ?? 0) !== 0) {
        return invalidateReport(state)
      }
      return state
    }
    const inline = Array.isArray(state.processedFiles) && state.processedFiles.length > 0
    const protectedInline = inline && state.processedFiles.some(hasClaudeUsageProtectedCheckpoint)
    if (protectedInline) {
      return initializePersistedClaudeUsageProjections(state)
    }
    return state.schemaVersion === 7 ? invalidateReport(state) : state
  } catch {
    return invalidateReport(state)
  }
}
