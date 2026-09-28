import { highestUsageKey } from '../usage/highest-usage-key'
import type {
  MuseUsageBreakdownKind,
  MuseUsageBreakdownRow,
  MuseUsageDailyPoint,
  MuseUsageRange,
  MuseUsageScope,
  MuseUsageSessionRow,
  MuseUsageSummary
} from '../../shared/muse-usage-types'
import type { MuseUsageDailyAggregate, MuseUsageSession } from './types'

type TokenTotals = Pick<
  MuseUsageDailyPoint,
  'inputTokens' | 'cachedInputTokens' | 'outputTokens' | 'reasoningOutputTokens' | 'totalTokens'
>

function emptyTotals(): TokenTotals {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  }
}

function addTotals(target: TokenTotals, row: MuseUsageDailyAggregate): void {
  target.inputTokens += row.inputTokens
  target.cachedInputTokens += row.cachedInputTokens
  target.outputTokens += row.outputTokens
  target.reasoningOutputTokens += row.reasoningOutputTokens
  target.totalTokens += row.totalTokens
}

export function buildMuseUsageSummary(
  scope: MuseUsageScope,
  range: MuseUsageRange,
  filteredDaily: MuseUsageDailyAggregate[],
  filteredSessions: MuseUsageSession[]
): MuseUsageSummary {
  const totals = emptyTotals()
  let events = 0
  const byModel = new Map<string, number>()
  const byProject = new Map<string, number>()
  for (const row of filteredDaily) {
    addTotals(totals, row)
    events += row.eventCount
    const model = row.model ?? 'Unknown model'
    byModel.set(model, (byModel.get(model) ?? 0) + row.totalTokens)
    byProject.set(row.projectLabel, (byProject.get(row.projectLabel) ?? 0) + row.totalTokens)
  }
  return {
    scope,
    range,
    sessions: filteredSessions.length,
    events,
    ...totals,
    topModel: highestUsageKey(byModel),
    topProject: highestUsageKey(byProject),
    hasAnyMuseData: filteredSessions.length > 0 || filteredDaily.length > 0
  }
}

export function buildMuseUsageDailyPoints(
  filteredDaily: MuseUsageDailyAggregate[]
): MuseUsageDailyPoint[] {
  const byDay = new Map<string, MuseUsageDailyPoint>()
  for (const row of filteredDaily) {
    const existing = byDay.get(row.day) ?? { day: row.day, ...emptyTotals() }
    addTotals(existing, row)
    byDay.set(row.day, existing)
  }
  return [...byDay.values()].sort((left, right) => left.day.localeCompare(right.day))
}

export function buildMuseUsageBreakdownRows(
  kind: MuseUsageBreakdownKind,
  scope: MuseUsageScope,
  filteredDaily: MuseUsageDailyAggregate[],
  filteredSessions: MuseUsageSession[]
): MuseUsageBreakdownRow[] {
  const rows = new Map<string, MuseUsageBreakdownRow>()
  for (const daily of filteredDaily) {
    const key = kind === 'model' ? (daily.model ?? 'unknown') : daily.projectKey
    const label = kind === 'model' ? (daily.model ?? 'Unknown model') : daily.projectLabel
    const existing = rows.get(key) ?? { key, label, sessions: 0, events: 0, ...emptyTotals() }
    existing.events += daily.eventCount
    addTotals(existing, daily)
    rows.set(key, existing)
  }

  for (const session of filteredSessions) {
    const keys =
      kind === 'model'
        ? session.locationModelBreakdown
            .filter((entry) => scope === 'all' || entry.worktreeId !== null)
            .map((entry) => entry.modelKey)
        : session.locationBreakdown
            .filter((entry) => scope === 'all' || entry.worktreeId !== null)
            .map((entry) => entry.locationKey)
    for (const key of new Set(keys)) {
      const row = rows.get(key)
      if (row) {
        row.sessions++
      }
    }
  }

  return [...rows.values()].sort((left, right) => right.totalTokens - left.totalTokens)
}

export function buildMuseUsageRecentSessions(
  filteredSessions: MuseUsageSession[],
  limit = 10
): MuseUsageSessionRow[] {
  return filteredSessions.slice(0, limit).map((session) => ({
    sessionId: session.sessionId,
    lastActiveAt: session.lastTimestamp,
    durationMinutes: Math.max(
      0,
      Math.round(
        (new Date(session.lastTimestamp).getTime() - new Date(session.firstTimestamp).getTime()) /
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
  }))
}
