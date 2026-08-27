import type {
  ClaudeUsageAttributedTurn,
  ClaudeUsageDailyAggregate,
  ClaudeUsageLocationBreakdown,
  ClaudeUsageSession
} from './types'

export function mergeClaudeSessions(
  target: Map<string, ClaudeUsageSession>,
  sessions: ClaudeUsageSession[]
): void {
  for (const session of sessions) {
    const existing = target.get(session.sessionId)
    if (!existing) {
      target.set(session.sessionId, structuredClone(session))
      continue
    }

    if (session.firstTimestamp < existing.firstTimestamp) {
      existing.firstTimestamp = session.firstTimestamp
    }
    if (session.lastTimestamp > existing.lastTimestamp) {
      existing.lastTimestamp = session.lastTimestamp
      existing.lastCwd = session.lastCwd
      existing.lastGitBranch = session.lastGitBranch
    }
    existing.model = session.model ?? existing.model
    existing.turnCount += session.turnCount
    existing.totalInputTokens += session.totalInputTokens
    existing.totalOutputTokens += session.totalOutputTokens
    existing.totalCacheReadTokens += session.totalCacheReadTokens
    existing.totalCacheWriteTokens += session.totalCacheWriteTokens

    for (const location of session.locationBreakdown) {
      const existingLocation =
        existing.locationBreakdown.find((entry) => entry.locationKey === location.locationKey) ??
        null
      if (existingLocation) {
        existingLocation.turnCount += location.turnCount
        existingLocation.inputTokens += location.inputTokens
        existingLocation.outputTokens += location.outputTokens
        existingLocation.cacheReadTokens += location.cacheReadTokens
        existingLocation.cacheWriteTokens += location.cacheWriteTokens
      } else {
        existing.locationBreakdown.push({ ...location })
      }
    }
  }
}

export function mergeClaudeDailyAggregates(
  target: Map<string, ClaudeUsageDailyAggregate>,
  dailyAggregates: ClaudeUsageDailyAggregate[]
): void {
  for (const aggregate of dailyAggregates) {
    const key = [aggregate.day, aggregate.model ?? 'unknown', aggregate.projectKey].join('::')
    const existing = target.get(key)
    if (!existing) {
      target.set(key, { ...aggregate })
      continue
    }
    existing.turnCount += aggregate.turnCount
    existing.zeroCacheReadTurnCount += aggregate.zeroCacheReadTurnCount
    existing.inputTokens += aggregate.inputTokens
    existing.outputTokens += aggregate.outputTokens
    existing.cacheReadTokens += aggregate.cacheReadTokens
    existing.cacheWriteTokens += aggregate.cacheWriteTokens
  }
}

export function finalizeClaudeSessions(
  sessionsById: Map<string, ClaudeUsageSession>
): ClaudeUsageSession[] {
  for (const session of sessionsById.values()) {
    session.locationBreakdown.sort((left, right) => {
      const leftTotal = left.inputTokens + left.outputTokens
      const rightTotal = right.inputTokens + right.outputTokens
      return rightTotal - leftTotal
    })
    const primaryLocation = session.locationBreakdown[0] ?? null
    if (primaryLocation) {
      session.primaryRepoId = primaryLocation.repoId
      session.primaryWorktreeId = primaryLocation.worktreeId
    }
  }

  return [...sessionsById.values()].sort((left, right) =>
    right.lastTimestamp.localeCompare(left.lastTimestamp)
  )
}

export function aggregateClaudeUsage(turns: ClaudeUsageAttributedTurn[]): {
  sessions: ClaudeUsageSession[]
  dailyAggregates: ClaudeUsageDailyAggregate[]
} {
  const sessionsById = new Map<string, ClaudeUsageSession>()
  const dailyByKey = new Map<string, ClaudeUsageDailyAggregate>()

  for (const turn of turns) {
    const existingSession = sessionsById.get(turn.sessionId)
    if (!existingSession) {
      sessionsById.set(turn.sessionId, {
        sessionId: turn.sessionId,
        firstTimestamp: turn.timestamp,
        lastTimestamp: turn.timestamp,
        model: turn.model,
        lastCwd: turn.cwd,
        lastGitBranch: turn.gitBranch,
        primaryWorktreeId: turn.worktreeId,
        primaryRepoId: turn.repoId,
        turnCount: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        locationBreakdown: []
      })
    }

    const session = sessionsById.get(turn.sessionId)!
    if (turn.timestamp < session.firstTimestamp) {
      session.firstTimestamp = turn.timestamp
    }
    if (turn.timestamp > session.lastTimestamp) {
      session.lastTimestamp = turn.timestamp
      session.lastCwd = turn.cwd
      session.lastGitBranch = turn.gitBranch
    }
    session.model = turn.model ?? session.model
    session.turnCount++
    session.totalInputTokens += turn.inputTokens
    session.totalOutputTokens += turn.outputTokens
    session.totalCacheReadTokens += turn.cacheReadTokens
    session.totalCacheWriteTokens += turn.cacheWriteTokens

    const location =
      session.locationBreakdown.find((entry) => entry.locationKey === turn.projectKey) ?? null
    if (location) {
      location.turnCount++
      location.inputTokens += turn.inputTokens
      location.outputTokens += turn.outputTokens
      location.cacheReadTokens += turn.cacheReadTokens
      location.cacheWriteTokens += turn.cacheWriteTokens
    } else {
      session.locationBreakdown.push({
        locationKey: turn.projectKey,
        projectLabel: turn.projectLabel,
        repoId: turn.repoId,
        worktreeId: turn.worktreeId,
        turnCount: 1,
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        cacheReadTokens: turn.cacheReadTokens,
        cacheWriteTokens: turn.cacheWriteTokens
      })
    }

    const dailyKey = [turn.day, turn.model ?? 'unknown', turn.projectKey].join('::')
    const existingDaily = dailyByKey.get(dailyKey)
    if (existingDaily) {
      existingDaily.turnCount++
      if (turn.cacheReadTokens === 0) {
        existingDaily.zeroCacheReadTurnCount++
      }
      existingDaily.inputTokens += turn.inputTokens
      existingDaily.outputTokens += turn.outputTokens
      existingDaily.cacheReadTokens += turn.cacheReadTokens
      existingDaily.cacheWriteTokens += turn.cacheWriteTokens
    } else {
      dailyByKey.set(dailyKey, {
        day: turn.day,
        model: turn.model,
        projectKey: turn.projectKey,
        projectLabel: turn.projectLabel,
        repoId: turn.repoId,
        worktreeId: turn.worktreeId,
        turnCount: 1,
        zeroCacheReadTurnCount: turn.cacheReadTokens === 0 ? 1 : 0,
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        cacheReadTokens: turn.cacheReadTokens,
        cacheWriteTokens: turn.cacheWriteTokens
      })
    }
  }

  return {
    sessions: finalizeClaudeSessions(sessionsById),
    dailyAggregates: [...dailyByKey.values()].sort((left, right) =>
      left.day === right.day
        ? left.projectLabel.localeCompare(right.projectLabel)
        : left.day.localeCompare(right.day)
    )
  }
}

export function getSessionProjectLabel(locationBreakdown: ClaudeUsageLocationBreakdown[]): string {
  if (locationBreakdown.length === 0) {
    return 'Unknown location'
  }
  if (locationBreakdown.length === 1) {
    return locationBreakdown[0].projectLabel
  }
  return 'Multiple locations'
}
