import type { ClaudeUsageParseResumeState, ClaudeUsagePersistedFile } from './types'
import {
  CLAUDE_USAGE_VALIDATION_BATCH_ROWS,
  iterateClaudeUsageProjectionIntegrity
} from './transcript-projection-integrity'

export function* iterateClaudeUsageResumeProjection(
  previous: ClaudeUsagePersistedFile
): Generator<void, boolean> {
  const state = previous.parseResumeState
  if (
    !state ||
    !Array.isArray(previous.ownedDedupeKeys) ||
    !Array.isArray(previous.sessions) ||
    !Array.isArray(previous.dailyAggregates) ||
    !Number.isInteger(state.lineCount) ||
    state.lineCount < 0 ||
    state.lineCount > previous.lineCount ||
    state.parsedBytes > previous.size ||
    !Array.isArray(state.ownedTokenMaxima) ||
    !Array.isArray(state.projections) ||
    !Array.isArray(state.encounterOrder) ||
    typeof state.projectionIntegrity !== 'string'
  ) {
    return false
  }
  const expectedKeys = new Set<string>()
  let checked = 0
  for (const key of previous.ownedDedupeKeys) {
    if (typeof key !== 'string') {
      return false
    }
    expectedKeys.add(key)
    if (++checked % CLAUDE_USAGE_VALIDATION_BATCH_ROWS === 0) {
      yield
    }
  }
  if (
    expectedKeys.size !== previous.ownedDedupeKeys.length ||
    state.ownedTokenMaxima.length !== expectedKeys.size
  ) {
    return false
  }
  // Bind ownership, maxima and rollups together; valid shapes alone cannot reject drift.
  if (state.projectionIntegrity !== (yield* iterateClaudeUsageProjectionIntegrity(previous))) {
    return false
  }
  const sessionLocations = new Map<string, Set<string>>()
  for (const session of previous.sessions) {
    const locations = new Set<string>()
    for (const location of session.locationBreakdown) {
      locations.add(location.locationKey)
      if (++checked % CLAUDE_USAGE_VALIDATION_BATCH_ROWS === 0) {
        yield
      }
    }
    sessionLocations.set(session.sessionId, locations)
    if (++checked % CLAUDE_USAGE_VALIDATION_BATCH_ROWS === 0) {
      yield
    }
  }
  const dailyKeys = new Set<string>()
  for (const day of previous.dailyAggregates) {
    dailyKeys.add([day.day, day.model ?? 'unknown', day.projectKey].join('::'))
    if (++checked % CLAUDE_USAGE_VALIDATION_BATCH_ROWS === 0) {
      yield
    }
  }
  if (state.projections.length > state.ownedTokenMaxima.length) {
    return false
  }
  const usedProjections = new Uint8Array(state.projections.length)
  let usedProjectionCount = 0
  for (const row of state.ownedTokenMaxima) {
    if (
      !Array.isArray(row) ||
      row.length !== 6 ||
      (row[5] !== null &&
        (!Number.isInteger(row[5]) || row[5] < 0 || row[5] >= state.projections.length))
    ) {
      return false
    }
    for (let index = 0; index < 5; index++) {
      if (typeof row[index] !== 'number' || !Number.isFinite(row[index])) {
        return false
      }
    }
    if (row[5] !== null && usedProjections[row[5]] === 0) {
      usedProjections[row[5]] = 1
      usedProjectionCount++
    }
    if (++checked % CLAUDE_USAGE_VALIDATION_BATCH_ROWS === 0) {
      yield
    }
  }
  if (usedProjectionCount !== state.projections.length) {
    return false
  }
  for (const projection of state.projections) {
    if (
      !projection ||
      typeof projection.sessionId !== 'string' ||
      typeof projection.day !== 'string' ||
      typeof projection.projectKey !== 'string' ||
      (projection.model !== null && typeof projection.model !== 'string') ||
      !sessionLocations.get(projection.sessionId)?.has(projection.projectKey) ||
      !dailyKeys.has(
        [projection.day, projection.model ?? 'unknown', projection.projectKey].join('::')
      )
    ) {
      return false
    }
    if (++checked % CLAUDE_USAGE_VALIDATION_BATCH_ROWS === 0) {
      yield
    }
  }
  if (state.encounterOrder.length !== sessionLocations.size) {
    return false
  }
  for (const entry of state.encounterOrder) {
    if (!entry || typeof entry.sessionId !== 'string' || !Array.isArray(entry.projectKeys)) {
      return false
    }
    const locations = sessionLocations.get(entry.sessionId)
    if (!locations) {
      return false
    }
    sessionLocations.delete(entry.sessionId)
    if (entry.projectKeys.length !== locations.size) {
      return false
    }
    for (const key of entry.projectKeys) {
      if (typeof key !== 'string' || !locations.delete(key)) {
        return false
      }
      if (++checked % CLAUDE_USAGE_VALIDATION_BATCH_ROWS === 0) {
        yield
      }
    }
  }
  return sessionLocations.size === 0
}

export function hasClaudeUsageResumeProjection(
  previous: ClaudeUsagePersistedFile
): previous is ClaudeUsagePersistedFile & { parseResumeState: ClaudeUsageParseResumeState } {
  const iterator = iterateClaudeUsageResumeProjection(previous)
  while (true) {
    const next = iterator.next()
    if (next.done) {
      return next.value
    }
  }
}
