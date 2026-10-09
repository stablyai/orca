import type { ClaudeUsageParseResumeState, ClaudeUsagePersistedFile } from './types'

export function hasClaudeUsageResumeProjection(
  previous: ClaudeUsagePersistedFile
): previous is ClaudeUsagePersistedFile & { parseResumeState: ClaudeUsageParseResumeState } {
  const state = previous.parseResumeState
  if (
    !state ||
    !Number.isInteger(state.lineCount) ||
    state.lineCount < 0 ||
    state.lineCount > previous.lineCount ||
    state.parsedBytes > previous.size ||
    !Array.isArray(state.ownedTokenMaxima) ||
    !Array.isArray(state.projections) ||
    !Array.isArray(state.encounterOrder)
  ) {
    return false
  }
  const expectedKeys = new Set(previous.ownedDedupeKeys)
  if (
    expectedKeys.size !== previous.ownedDedupeKeys.length ||
    state.ownedTokenMaxima.length !== expectedKeys.size
  ) {
    return false
  }
  const sessions = new Map(previous.sessions.map((session) => [session.sessionId, session]))
  const dailyKeys = new Set(
    previous.dailyAggregates.map((day) =>
      [day.day, day.model ?? 'unknown', day.projectKey].join('::')
    )
  )
  for (const key of previous.ownedDedupeKeys) {
    if (typeof key !== 'string') {
      return false
    }
  }
  const usedProjections = new Set<number>()
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
    if (row[5] !== null) {
      usedProjections.add(row[5])
    }
  }
  if (usedProjections.size !== state.projections.length) {
    return false
  }
  for (const projection of state.projections) {
    if (
      !projection ||
      typeof projection.sessionId !== 'string' ||
      typeof projection.day !== 'string' ||
      typeof projection.projectKey !== 'string' ||
      (projection.model !== null && typeof projection.model !== 'string') ||
      !sessions
        .get(projection.sessionId)
        ?.locationBreakdown.some((location) => location.locationKey === projection.projectKey) ||
      !dailyKeys.has(
        [projection.day, projection.model ?? 'unknown', projection.projectKey].join('::')
      )
    ) {
      return false
    }
  }
  if (state.encounterOrder.length !== sessions.size) {
    return false
  }
  const remainingSessions = new Map(sessions)
  for (const entry of state.encounterOrder) {
    if (!entry || typeof entry.sessionId !== 'string' || !Array.isArray(entry.projectKeys)) {
      return false
    }
    const session = remainingSessions.get(entry.sessionId)
    if (!session) {
      return false
    }
    remainingSessions.delete(entry.sessionId)
    const locations = new Set(session.locationBreakdown.map((location) => location.locationKey))
    if (entry.projectKeys.length !== locations.size) {
      return false
    }
    for (const key of entry.projectKeys) {
      if (typeof key !== 'string' || !locations.delete(key)) {
        return false
      }
    }
  }
  return remainingSessions.size === 0
}
