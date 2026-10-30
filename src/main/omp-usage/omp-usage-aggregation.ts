import type { OmpUsageDailyAggregate, OmpUsagePersistedFile, OmpUsageSession } from './types'

/** Later projections carry the newer model and location; token counters always sum. */
export function combineOmpSessions(left: OmpUsageSession, right: OmpUsageSession): OmpUsageSession {
  const leftEnd = left.endedAt ?? left.startedAt
  const rightEnd = right.endedAt ?? right.startedAt
  const later = leftEnd <= rightEnd ? right : left
  return {
    sessionId: left.sessionId,
    startedAt: left.startedAt <= right.startedAt ? left.startedAt : right.startedAt,
    endedAt: later.endedAt,
    cwd: later.cwd || left.cwd,
    model: later.model,
    provider: later.provider,
    ...(later.repoId !== undefined
      ? { repoId: later.repoId }
      : left.repoId !== undefined
        ? { repoId: left.repoId }
        : {}),
    ...(later.worktreeId !== undefined
      ? { worktreeId: later.worktreeId }
      : left.worktreeId !== undefined
        ? { worktreeId: left.worktreeId }
        : {}),
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    costUsd: left.costUsd + right.costUsd
  }
}

export function addOmpDailyAggregate(
  target: Map<string, OmpUsageDailyAggregate>,
  aggregate: OmpUsageDailyAggregate
): void {
  const existing = target.get(aggregate.day)
  if (!existing) {
    target.set(aggregate.day, { ...aggregate })
    return
  }
  existing.inputTokens += aggregate.inputTokens
  existing.outputTokens += aggregate.outputTokens
  existing.cacheReadTokens += aggregate.cacheReadTokens
  existing.cacheWriteTokens += aggregate.cacheWriteTokens
  existing.reasoningTokens += aggregate.reasoningTokens
  existing.totalTokens += aggregate.totalTokens
  existing.costUsd += aggregate.costUsd
}

export function mergeDailyAggregates(
  previous: OmpUsageDailyAggregate[],
  appended: OmpUsageDailyAggregate[]
): OmpUsageDailyAggregate[] {
  const byDay = new Map(previous.map((aggregate) => [aggregate.day, { ...aggregate }]))
  for (const aggregate of appended) {
    addOmpDailyAggregate(byDay, aggregate)
  }
  return [...byDay.values()].sort((left, right) => left.day.localeCompare(right.day))
}

/** Extend a cached projection with only the lines appended since its checkpoint. */
export function mergeAppendedFile(
  previous: OmpUsagePersistedFile,
  appended: OmpUsagePersistedFile
): OmpUsagePersistedFile {
  const previousSession = previous.sessions[0]
  const appendedSession = appended.sessions[0]
  let sessions: OmpUsageSession[]
  if (!appendedSession) {
    sessions = previous.sessions
  } else if (!previousSession) {
    sessions = [appendedSession]
  } else if (previousSession.sessionId === appendedSession.sessionId) {
    sessions = [combineOmpSessions(previousSession, appendedSession)]
  } else {
    // A session boundary inside one file must not fold a new session into the cached one.
    sessions = [previousSession, appendedSession]
  }
  return {
    ...appended,
    sessions,
    dailyAggregates: mergeDailyAggregates(previous.dailyAggregates, appended.dailyAggregates)
  }
}
