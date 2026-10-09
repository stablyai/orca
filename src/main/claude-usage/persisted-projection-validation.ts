import type {
  ClaudeUsageDailyAggregate,
  ClaudeUsagePersistedState,
  ClaudeUsageSession
} from './types'
import { hasClaudeUsageResumeProjection } from './transcript-resume-projection'
import {
  finalizeClaudeSessions,
  mergeClaudeDailyAggregates,
  mergeClaudeSessions
} from './usage-aggregation'

function invalidateSavedProjections(
  state: ClaudeUsagePersistedState,
  processedFiles: ClaudeUsagePersistedState['processedFiles']
): ClaudeUsagePersistedState {
  return {
    ...state,
    processedFiles,
    sessions: [],
    dailyAggregates: [],
    scanState: {
      ...state.scanState,
      lastScanCompletedAt: null,
      lastScanError: 'Saved usage totals could not be validated. Refresh to rebuild them.'
    }
  }
}

function validateSavedProjections(state: ClaudeUsagePersistedState): ClaudeUsagePersistedState {
  if (
    !state.processedFiles.some((file) => file.parseResumeState?.projectionIntegrity !== undefined)
  ) {
    return state
  }
  const invalidFiles = new Set(
    state.processedFiles.filter(
      (file) =>
        file.parseResumeState?.projectionIntegrity !== undefined &&
        !hasClaudeUsageResumeProjection(file)
    )
  )
  // Lost owners require deferred forks to reclaim their copied records on the next scan.
  const processedFiles = state.processedFiles.filter(
    (file) => !invalidFiles.has(file) && (invalidFiles.size === 0 || !file.hasDeferredClaims)
  )
  if (invalidFiles.size > 0) {
    return invalidateSavedProjections(state, processedFiles)
  }
  const sessions = new Map<string, ClaudeUsageSession>()
  const daily = new Map<string, ClaudeUsageDailyAggregate>()
  for (const file of processedFiles) {
    mergeClaudeSessions(sessions, file.sessions)
    mergeClaudeDailyAggregates(daily, file.dailyAggregates)
  }
  return {
    ...state,
    processedFiles,
    sessions: finalizeClaudeSessions(sessions),
    dailyAggregates: [...daily.values()].sort((a, b) =>
      a.day === b.day ? a.projectLabel.localeCompare(b.projectLabel) : a.day.localeCompare(b.day)
    ),
    scanState: state.scanState
  }
}

export function validatePersistedClaudeUsageProjections(
  state: ClaudeUsagePersistedState
): ClaudeUsagePersistedState {
  try {
    return validateSavedProjections(state)
  } catch {
    // Malformed cache records must not reset the user's tracking preference.
    return invalidateSavedProjections(state, [])
  }
}
