import type {
  KimiUsageBreakdownKind,
  KimiUsageBreakdownRow,
  KimiUsageDailyPoint,
  KimiUsageRange,
  KimiUsageScope,
  KimiUsageSessionRow,
  KimiUsageSummary
} from '../../shared/kimi-usage-types'
import { addCost } from './cost-aggregation'
import type { KimiUsageDailyAggregate, KimiUsageSession } from './types'

function getRangeCutoff(range: KimiUsageRange): string | null {
  if (range === 'all') {
    return null
  }
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90
  const now = new Date()
  now.setHours(0, 0, 0, 0)
  now.setDate(now.getDate() - (days - 1))
  const year = now.getFullYear()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function getLocalDay(timestamp: string): string | null {
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }
  const year = parsed.getFullYear()
  const month = String(parsed.getMonth() + 1).padStart(2, '0')
  const day = String(parsed.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function getFilteredDaily(
  dailyAggregates: KimiUsageDailyAggregate[],
  scope: KimiUsageScope,
  range: KimiUsageRange
): KimiUsageDailyAggregate[] {
  const cutoff = getRangeCutoff(range)
  return dailyAggregates.filter((row) => {
    if (scope === 'orca' && !row.worktreeId) {
      return false
    }
    if (cutoff && row.day < cutoff) {
      return false
    }
    return true
  })
}

export function getFilteredSessions(
  sessions: KimiUsageSession[],
  scope: KimiUsageScope,
  range: KimiUsageRange
): KimiUsageSession[] {
  const cutoff = getRangeCutoff(range)
  return sessions.filter((session) => {
    if (scope === 'orca' && !session.primaryWorktreeId) {
      return false
    }
    if (cutoff) {
      const day = getLocalDay(session.lastTimestamp)
      if (!day || day < cutoff) {
        return false
      }
    }
    return true
  })
}

export function buildSummary(
  sessions: KimiUsageSession[],
  dailyAggregates: KimiUsageDailyAggregate[],
  scope: KimiUsageScope,
  range: KimiUsageRange
): KimiUsageSummary {
  const filteredDaily = getFilteredDaily(dailyAggregates, scope, range)
  const filteredSessions = getFilteredSessions(sessions, scope, range)

  let inputTokens = 0
  let cachedInputTokens = 0
  let outputTokens = 0
  let reasoningOutputTokens = 0
  let totalTokens = 0
  let events = 0
  let estimatedCostUsd: number | null = null
  const byModel = new Map<string, number>()
  const byProject = new Map<string, number>()

  for (const row of filteredDaily) {
    inputTokens += row.inputTokens
    cachedInputTokens += row.cachedInputTokens
    outputTokens += row.outputTokens
    reasoningOutputTokens += row.reasoningOutputTokens
    totalTokens += row.totalTokens
    events += row.eventCount
    estimatedCostUsd = addCost(estimatedCostUsd, row.estimatedCostUsd)
    byModel.set(
      row.model ?? 'Unknown model',
      (byModel.get(row.model ?? 'Unknown model') ?? 0) + row.totalTokens
    )
    byProject.set(row.projectLabel, (byProject.get(row.projectLabel) ?? 0) + row.totalTokens)
  }

  const topModel = [...byModel.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null
  const topProject =
    [...byProject.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null

  return {
    scope,
    range,
    sessions: filteredSessions.length,
    events,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
    estimatedCostUsd,
    topModel,
    topProject,
    hasAnyKimiData: filteredSessions.length > 0 || filteredDaily.length > 0
  }
}

export function buildDaily(
  _sessions: KimiUsageSession[],
  dailyAggregates: KimiUsageDailyAggregate[],
  scope: KimiUsageScope,
  range: KimiUsageRange
): KimiUsageDailyPoint[] {
  const byDay = new Map<string, KimiUsageDailyPoint>()
  for (const row of getFilteredDaily(dailyAggregates, scope, range)) {
    const existing = byDay.get(row.day) ?? {
      day: row.day,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0
    }
    existing.inputTokens += row.inputTokens
    existing.cachedInputTokens += row.cachedInputTokens
    existing.outputTokens += row.outputTokens
    existing.reasoningOutputTokens += row.reasoningOutputTokens
    existing.totalTokens += row.totalTokens
    byDay.set(row.day, existing)
  }
  return [...byDay.values()].sort((left, right) => left.day.localeCompare(right.day))
}

export function buildBreakdown(
  sessions: KimiUsageSession[],
  dailyAggregates: KimiUsageDailyAggregate[],
  scope: KimiUsageScope,
  range: KimiUsageRange,
  kind: KimiUsageBreakdownKind
): KimiUsageBreakdownRow[] {
  const rows = new Map<string, KimiUsageBreakdownRow>()
  const filteredDaily = getFilteredDaily(dailyAggregates, scope, range)
  const filteredSessions = getFilteredSessions(sessions, scope, range)

  for (const daily of filteredDaily) {
    const key = kind === 'model' ? (daily.model ?? 'unknown') : daily.projectKey
    const label = kind === 'model' ? (daily.model ?? 'Unknown model') : daily.projectLabel
    const existing = rows.get(key) ?? {
      key,
      label,
      sessions: 0,
      events: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: null
    }
    existing.events += daily.eventCount
    existing.inputTokens += daily.inputTokens
    existing.cachedInputTokens += daily.cachedInputTokens
    existing.outputTokens += daily.outputTokens
    existing.reasoningOutputTokens += daily.reasoningOutputTokens
    existing.totalTokens += daily.totalTokens
    existing.estimatedCostUsd = addCost(existing.estimatedCostUsd, daily.estimatedCostUsd)
    rows.set(key, existing)
  }

  if (kind === 'model') {
    for (const session of filteredSessions) {
      for (const entry of session.modelBreakdown) {
        const row = rows.get(entry.modelKey)
        if (row) {
          row.sessions++
        }
      }
    }
  } else {
    for (const session of filteredSessions) {
      for (const entry of session.locationBreakdown) {
        const row = rows.get(entry.locationKey)
        if (row) {
          row.sessions++
        }
      }
    }
  }

  return [...rows.values()].sort((left, right) => right.totalTokens - left.totalTokens)
}

export function buildRecentSessions(
  sessions: KimiUsageSession[],
  _dailyAggregates: KimiUsageDailyAggregate[],
  scope: KimiUsageScope,
  range: KimiUsageRange,
  limit = 10
): KimiUsageSessionRow[] {
  return getFilteredSessions(sessions, scope, range)
    .slice(0, limit)
    .map(
      (session): KimiUsageSessionRow => ({
        sessionId: session.sessionId,
        lastActiveAt: session.lastTimestamp,
        durationMinutes: Math.max(
          0,
          Math.round(
            (new Date(session.lastTimestamp).getTime() -
              new Date(session.firstTimestamp).getTime()) /
              60_000
          )
        ),
        projectLabel: session.primaryProjectLabel,
        model: session.primaryModel,
        events: session.eventCount,
        inputTokens: session.totalInputTokens,
        cachedInputTokens: session.totalCachedInputTokens,
        outputTokens: session.totalOutputTokens,
        reasoningOutputTokens: session.totalReasoningOutputTokens,
        totalTokens: session.totalTokens
      })
    )
}
