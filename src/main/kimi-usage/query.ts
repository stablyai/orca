import type {
  KimiUsageBreakdownKind,
  KimiUsageBreakdownRow,
  KimiUsageDailyPoint,
  KimiUsageRange,
  KimiUsageScanState,
  KimiUsageScope,
  KimiUsageSessionRow,
  KimiUsageSnapshot,
  KimiUsageSummary
} from '../../shared/kimi-usage-types'
import type { KimiUsageDailyAggregate, KimiUsagePersistedState, KimiUsageSession } from './types'
import { localDayFromTimestamp } from './local-day'

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

export function buildKimiUsageSnapshot(
  state: KimiUsagePersistedState,
  scanState: KimiUsageScanState,
  scope: KimiUsageScope,
  range: KimiUsageRange,
  recentSessionLimit = 10
): KimiUsageSnapshot {
  return {
    scanState,
    summary: buildKimiUsageSummary(state, scope, range),
    daily: buildKimiUsageDaily(state, scope, range),
    modelBreakdown: buildKimiUsageBreakdown(state, scope, range, 'model'),
    projectBreakdown: buildKimiUsageBreakdown(state, scope, range, 'project'),
    recentSessions: buildKimiRecentSessions(state, scope, range, recentSessionLimit)
  }
}

export function buildKimiUsageSummary(
  state: KimiUsagePersistedState,
  scope: KimiUsageScope,
  range: KimiUsageRange
): KimiUsageSummary {
  const filteredDaily = getFilteredDaily(state, scope, range)
  const filteredSessions = getFilteredSessions(state, scope, range)
  const totals = {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    events: 0
  }
  const byModel = new Map<string, number>()
  const byProject = new Map<string, number>()

  for (const row of filteredDaily) {
    totals.inputTokens += row.inputTokens
    totals.cachedInputTokens += row.cachedInputTokens
    totals.cacheCreationTokens += row.cacheCreationTokens
    totals.outputTokens += row.outputTokens
    totals.totalTokens += row.totalTokens
    totals.events += row.eventCount
    byModel.set(
      row.model ?? 'Unknown model',
      (byModel.get(row.model ?? 'Unknown model') ?? 0) + row.totalTokens
    )
    byProject.set(row.projectLabel, (byProject.get(row.projectLabel) ?? 0) + row.totalTokens)
  }

  return {
    scope,
    range,
    sessions: filteredSessions.length,
    events: totals.events,
    inputTokens: totals.inputTokens,
    cachedInputTokens: totals.cachedInputTokens,
    cacheCreationTokens: totals.cacheCreationTokens,
    outputTokens: totals.outputTokens,
    totalTokens: totals.totalTokens,
    topModel: getTopKey(byModel),
    topProject: getTopKey(byProject),
    hasAnyKimiData: filteredSessions.length > 0 || filteredDaily.length > 0
  }
}

function getTopKey(values: Map<string, number>): string | null {
  return [...values.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null
}

export function buildKimiUsageDaily(
  state: KimiUsagePersistedState,
  scope: KimiUsageScope,
  range: KimiUsageRange
): KimiUsageDailyPoint[] {
  const byDay = new Map<string, KimiUsageDailyPoint>()
  for (const row of getFilteredDaily(state, scope, range)) {
    const existing = byDay.get(row.day) ?? {
      day: row.day,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      totalTokens: 0
    }
    existing.inputTokens += row.inputTokens
    existing.cachedInputTokens += row.cachedInputTokens
    existing.cacheCreationTokens += row.cacheCreationTokens
    existing.outputTokens += row.outputTokens
    existing.totalTokens += row.totalTokens
    byDay.set(row.day, existing)
  }
  return [...byDay.values()].sort((left, right) => left.day.localeCompare(right.day))
}

export function buildKimiUsageBreakdown(
  state: KimiUsagePersistedState,
  scope: KimiUsageScope,
  range: KimiUsageRange,
  kind: KimiUsageBreakdownKind
): KimiUsageBreakdownRow[] {
  const rows = new Map<string, KimiUsageBreakdownRow>()
  const filteredDaily = getFilteredDaily(state, scope, range)
  const filteredSessions = getFilteredSessions(state, scope, range)

  for (const daily of filteredDaily) {
    const key = kind === 'model' ? (daily.model ?? 'unknown') : daily.projectKey
    const label = kind === 'model' ? (daily.model ?? 'Unknown model') : daily.projectLabel
    const existing = rows.get(key) ?? createBreakdownRow(key, label)
    existing.events += daily.eventCount
    existing.inputTokens += daily.inputTokens
    existing.cachedInputTokens += daily.cachedInputTokens
    existing.cacheCreationTokens += daily.cacheCreationTokens
    existing.outputTokens += daily.outputTokens
    existing.totalTokens += daily.totalTokens
    rows.set(key, existing)
  }

  countBreakdownSessions(rows, filteredSessions, kind)
  return [...rows.values()].sort((left, right) => right.totalTokens - left.totalTokens)
}

function createBreakdownRow(key: string, label: string): KimiUsageBreakdownRow {
  return {
    key,
    label,
    sessions: 0,
    events: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    totalTokens: 0
  }
}

function countBreakdownSessions(
  rows: Map<string, KimiUsageBreakdownRow>,
  sessions: KimiUsageSession[],
  kind: KimiUsageBreakdownKind
): void {
  for (const session of sessions) {
    if (kind === 'model') {
      for (const entry of session.modelBreakdown) {
        const row = rows.get(entry.modelKey)
        if (row) {
          row.sessions++
        }
      }
      continue
    }
    for (const entry of session.locationBreakdown) {
      const key = entry.locationKey
      const row = rows.get(key)
      if (row) {
        row.sessions++
      }
    }
  }
}

export function buildKimiRecentSessions(
  state: KimiUsagePersistedState,
  scope: KimiUsageScope,
  range: KimiUsageRange,
  limit = 10
): KimiUsageSessionRow[] {
  return getFilteredSessions(state, scope, range)
    .slice(0, limit)
    .map((session): KimiUsageSessionRow => ({
      sessionId: session.sessionId,
      lastActiveAt: session.lastTimestamp,
      durationMinutes: getSessionDurationMinutes(session),
      projectLabel: session.primaryProjectLabel,
      model: session.primaryModel,
      events: session.eventCount,
      inputTokens: session.totalInputTokens,
      cachedInputTokens: session.totalCachedInputTokens,
      cacheCreationTokens: session.totalCacheCreationTokens,
      outputTokens: session.totalOutputTokens,
      totalTokens: session.totalTokens
    }))
}

function getSessionDurationMinutes(session: KimiUsageSession): number {
  return Math.max(
    0,
    Math.round(
      (new Date(session.lastTimestamp).getTime() - new Date(session.firstTimestamp).getTime()) /
        60_000
    )
  )
}

function getFilteredDaily(
  state: KimiUsagePersistedState,
  scope: KimiUsageScope,
  range: KimiUsageRange
): KimiUsageDailyAggregate[] {
  const cutoff = getRangeCutoff(range)
  return state.dailyAggregates.filter((row) => {
    if (scope === 'orca' && !row.worktreeId) {
      return false
    }
    if (cutoff && row.day < cutoff) {
      return false
    }
    return true
  })
}

function getFilteredSessions(
  state: KimiUsagePersistedState,
  scope: KimiUsageScope,
  range: KimiUsageRange
): KimiUsageSession[] {
  const cutoff = getRangeCutoff(range)
  return state.sessions.filter((session) => {
    if (scope === 'orca' && !session.primaryWorktreeId) {
      return false
    }
    if (cutoff) {
      const day = localDayFromTimestamp(session.lastTimestamp)
      if (!day || day < cutoff) {
        return false
      }
    }
    return true
  })
}
