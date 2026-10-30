import { basename } from 'node:path'
import type {
  OmpUsageBreakdownKind,
  OmpUsageBreakdownRow,
  OmpUsageDailyPoint,
  OmpUsageRange,
  OmpUsageScope,
  OmpUsageSessionRow,
  OmpUsageSummary
} from '../../shared/omp-usage-types'
import { highestUsageKey } from '../usage/highest-usage-key'
import { getLocalUsageDay, getUsageRangeCutoff } from '../usage/usage-calendar-range'
import type { OmpUsageDailyAggregate, OmpUsageSession } from './types'

/**
 * omp's persisted daily aggregates are flat per day (no worktree attribution), so a scope can
 * narrow sessions and their rollups but not the day series. Range still applies to both.
 */
export function filterOmpUsageDaily(
  daily: readonly OmpUsageDailyAggregate[],
  range: OmpUsageRange
): OmpUsageDailyAggregate[] {
  const cutoff = getUsageRangeCutoff(range)
  return daily.filter((entry) => !cutoff || entry.day >= cutoff)
}

export function filterOmpUsageSessions(
  sessions: readonly OmpUsageSession[],
  scope: OmpUsageScope,
  range: OmpUsageRange
): OmpUsageSession[] {
  const cutoff = getUsageRangeCutoff(range)
  return sessions.filter((session) => {
    const day = getLocalUsageDay(session.endedAt ?? session.startedAt)
    if (!day || (cutoff && day < cutoff)) {
      return false
    }
    return scope === 'all' || session.worktreeId !== undefined
  })
}

function projectLabel(session: OmpUsageSession): string {
  return basename(session.cwd) || session.cwd
}

export function buildOmpUsageSummary(
  scope: OmpUsageScope,
  range: OmpUsageRange,
  filteredSessions: OmpUsageSession[]
): OmpUsageSummary {
  let inputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let outputTokens = 0
  let reasoningTokens = 0
  let totalTokens = 0
  let costUsd = 0
  const byModel = new Map<string, number>()
  const byProject = new Map<string, number>()

  for (const session of filteredSessions) {
    inputTokens += session.inputTokens
    cacheReadTokens += session.cacheReadTokens
    cacheWriteTokens += session.cacheWriteTokens
    outputTokens += session.outputTokens
    reasoningTokens += session.reasoningTokens
    totalTokens += session.totalTokens
    costUsd += session.costUsd
    const model = session.model || 'Unknown model'
    byModel.set(model, (byModel.get(model) ?? 0) + session.totalTokens)
    const label = projectLabel(session)
    byProject.set(label, (byProject.get(label) ?? 0) + session.totalTokens)
  }

  return {
    scope,
    range,
    sessions: filteredSessions.length,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    costUsd,
    topModel: highestUsageKey(byModel),
    topProject: highestUsageKey(byProject),
    hasAnyOmpData: filteredSessions.length > 0
  }
}

export function buildOmpUsageDailyPoints(
  filteredDaily: readonly OmpUsageDailyAggregate[]
): OmpUsageDailyPoint[] {
  return filteredDaily.map((entry) => ({
    day: entry.day,
    inputTokens: entry.inputTokens,
    cacheReadTokens: entry.cacheReadTokens,
    cacheWriteTokens: entry.cacheWriteTokens,
    outputTokens: entry.outputTokens,
    reasoningTokens: entry.reasoningTokens,
    totalTokens: entry.totalTokens,
    costUsd: entry.costUsd
  }))
}

export function buildOmpUsageBreakdownRows(
  kind: OmpUsageBreakdownKind,
  filteredSessions: readonly OmpUsageSession[]
): OmpUsageBreakdownRow[] {
  const rows = new Map<string, OmpUsageBreakdownRow>()
  for (const session of filteredSessions) {
    const key = kind === 'model' ? session.model || 'unknown' : (session.worktreeId ?? session.cwd)
    const existing = rows.get(key) ?? {
      key,
      label: kind === 'model' ? session.model || 'Unknown model' : projectLabel(session),
      sessions: 0,
      inputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      costUsd: 0
    }
    existing.sessions += 1
    existing.inputTokens += session.inputTokens
    existing.cacheReadTokens += session.cacheReadTokens
    existing.cacheWriteTokens += session.cacheWriteTokens
    existing.outputTokens += session.outputTokens
    existing.reasoningTokens += session.reasoningTokens
    existing.totalTokens += session.totalTokens
    existing.costUsd += session.costUsd
    rows.set(key, existing)
  }
  return [...rows.values()].sort((left, right) => right.totalTokens - left.totalTokens)
}

export function buildOmpUsageRecentSessions(
  filteredSessions: readonly OmpUsageSession[],
  limit = 10
): OmpUsageSessionRow[] {
  return (
    filteredSessions
      .map((session) => {
        const lastActiveAt = session.endedAt ?? session.startedAt
        const parsed = Date.parse(lastActiveAt)
        return { session, lastActiveAt, lastActiveTime: Number.isNaN(parsed) ? 0 : parsed }
      })
      // The column shows last activity, not session start; the store may hand over an unsorted list.
      .sort((left, right) => right.lastActiveTime - left.lastActiveTime)
      .slice(0, limit)
      .map(({ session, lastActiveAt }) => ({
        sessionId: session.sessionId,
        lastActiveAt,
        durationMinutes: Math.max(
          0,
          Math.round(
            (new Date(lastActiveAt).getTime() - new Date(session.startedAt).getTime()) / 60_000
          )
        ),
        projectLabel: projectLabel(session),
        model: session.model || null,
        inputTokens: session.inputTokens,
        cacheReadTokens: session.cacheReadTokens,
        cacheWriteTokens: session.cacheWriteTokens,
        outputTokens: session.outputTokens,
        reasoningTokens: session.reasoningTokens,
        totalTokens: session.totalTokens,
        costUsd: session.costUsd
      }))
  )
}
