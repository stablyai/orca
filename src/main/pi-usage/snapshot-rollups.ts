import { highestUsageKey } from '../usage/highest-usage-key'
import { addUsageCost } from '../usage/usage-cost'
import type {
  PiUsageBreakdownKind,
  PiUsageBreakdownRow,
  PiUsageDailyPoint,
  PiUsageRange,
  PiUsageScope,
  PiUsageSessionRow,
  PiUsageSummary
} from '../../shared/pi-usage-types'
import type { PiUsageDailyAggregate, PiUsageSession } from './types'

type TokenTotals = Pick<
  PiUsageDailyPoint,
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

function addTotals(target: TokenTotals, row: PiUsageDailyAggregate): void {
  target.inputTokens += row.inputTokens
  target.cachedInputTokens += row.cachedInputTokens
  target.outputTokens += row.outputTokens
  target.reasoningOutputTokens += row.reasoningOutputTokens
  target.totalTokens += row.totalTokens
}

export function buildPiUsageSummary(
  scope: PiUsageScope,
  range: PiUsageRange,
  filteredDaily: PiUsageDailyAggregate[],
  filteredSessions: PiUsageSession[]
): PiUsageSummary {
  const totals = emptyTotals()
  let events = 0
  let estimatedCostUsd: number | null = null
  const byModel = new Map<string, number>()
  const byProject = new Map<string, number>()
  for (const row of filteredDaily) {
    addTotals(totals, row)
    events += row.eventCount
    estimatedCostUsd = addUsageCost(estimatedCostUsd, row.estimatedCostUsd)
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
    estimatedCostUsd,
    topModel: highestUsageKey(byModel),
    topProject: highestUsageKey(byProject),
    hasAnyPiData: filteredSessions.length > 0 || filteredDaily.length > 0
  }
}

export function buildPiUsageDailyPoints(
  filteredDaily: PiUsageDailyAggregate[]
): PiUsageDailyPoint[] {
  const byDay = new Map<string, PiUsageDailyPoint>()
  for (const row of filteredDaily) {
    const existing = byDay.get(row.day) ?? { day: row.day, ...emptyTotals() }
    addTotals(existing, row)
    byDay.set(row.day, existing)
  }
  return [...byDay.values()].sort((left, right) => left.day.localeCompare(right.day))
}

export function buildPiUsageBreakdownRows(
  kind: PiUsageBreakdownKind,
  scope: PiUsageScope,
  filteredDaily: PiUsageDailyAggregate[],
  filteredSessions: PiUsageSession[]
): PiUsageBreakdownRow[] {
  const rows = new Map<string, PiUsageBreakdownRow>()
  for (const daily of filteredDaily) {
    const key = kind === 'model' ? (daily.model ?? 'unknown') : daily.projectKey
    const label = kind === 'model' ? (daily.model ?? 'Unknown model') : daily.projectLabel
    const existing = rows.get(key) ?? {
      key,
      label,
      sessions: 0,
      events: 0,
      ...emptyTotals(),
      estimatedCostUsd: null
    }
    existing.events += daily.eventCount
    existing.estimatedCostUsd = addUsageCost(existing.estimatedCostUsd, daily.estimatedCostUsd)
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

export function buildPiUsageRecentSessions(
  filteredSessions: PiUsageSession[],
  limit = 10
): PiUsageSessionRow[] {
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
