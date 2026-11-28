import { highestUsageKey } from '../usage/rollups/highest-usage-key'
import type {
  AntigravityUsageBreakdownKind,
  AntigravityUsageBreakdownRow,
  AntigravityUsageDailyPoint,
  AntigravityUsageRange,
  AntigravityUsageScope,
  AntigravityUsageSessionRow,
  AntigravityUsageSummary
} from '../../shared/agent-usage/analytics/antigravity-usage-types'
import type { AntigravityUsageDailyAggregate, AntigravityUsageSession } from './types'

type TokenTotals = Pick<
  AntigravityUsageDailyPoint,
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

function addTotals(target: TokenTotals, row: AntigravityUsageDailyAggregate): void {
  target.inputTokens += row.inputTokens
  target.cachedInputTokens += row.cachedInputTokens
  target.outputTokens += row.outputTokens
  target.reasoningOutputTokens += row.reasoningOutputTokens
  target.totalTokens += row.totalTokens
}

export function buildAntigravityUsageSummary(
  scope: AntigravityUsageScope,
  range: AntigravityUsageRange,
  filteredDaily: AntigravityUsageDailyAggregate[],
  filteredSessions: AntigravityUsageSession[]
): AntigravityUsageSummary {
  const totals = emptyTotals()
  let events = 0
  const modelTotals = new Map<string, number>()
  const projectTotals = new Map<string, number>()
  for (const row of filteredDaily) {
    addTotals(totals, row)
    events += row.eventCount
    if (row.model) {
      modelTotals.set(row.model, (modelTotals.get(row.model) ?? 0) + row.totalTokens)
    }
    projectTotals.set(
      row.projectLabel,
      (projectTotals.get(row.projectLabel) ?? 0) + row.totalTokens
    )
  }
  return {
    scope,
    range,
    sessions: filteredSessions.length,
    events,
    ...totals,
    topModel: highestUsageKey(modelTotals),
    topProject: highestUsageKey(projectTotals),
    hasAnyAntigravityData: filteredSessions.length > 0 || filteredDaily.length > 0
  }
}

export function buildAntigravityUsageDailyPoints(
  filteredDaily: AntigravityUsageDailyAggregate[]
): AntigravityUsageDailyPoint[] {
  const byDay = new Map<string, AntigravityUsageDailyPoint>()
  for (const row of filteredDaily) {
    const existing = byDay.get(row.day) ?? { day: row.day, ...emptyTotals() }
    addTotals(existing, row)
    byDay.set(row.day, existing)
  }
  return [...byDay.values()].sort((left, right) => left.day.localeCompare(right.day))
}

export function buildAntigravityUsageBreakdownRows(
  kind: AntigravityUsageBreakdownKind,
  scope: AntigravityUsageScope,
  filteredDaily: AntigravityUsageDailyAggregate[],
  filteredSessions: AntigravityUsageSession[]
): AntigravityUsageBreakdownRow[] {
  const rows = new Map<string, AntigravityUsageBreakdownRow>()
  const sessionSets = new Map<string, Set<string>>()
  for (const entry of filteredDaily) {
    const key = kind === 'model' ? (entry.model ?? 'unknown') : entry.projectKey
    const label = kind === 'model' ? (entry.model ?? 'Unknown') : entry.projectLabel
    const row = rows.get(key) ?? { key, label, sessions: 0, events: 0, ...emptyTotals() }
    row.events += entry.eventCount
    addTotals(row, entry)
    rows.set(key, row)
  }
  for (const session of filteredSessions) {
    const keys =
      kind === 'model'
        ? scope === 'orca'
          ? session.locationModelBreakdown
              .filter((entry) => entry.worktreeId !== null)
              .map((entry) => entry.modelKey)
          : session.modelBreakdown.map((entry) => entry.modelKey)
        : session.locationBreakdown
            .filter((entry) => scope === 'all' || entry.worktreeId !== null)
            .map((entry) => entry.locationKey)
    for (const key of keys) {
      const set = sessionSets.get(key) ?? new Set<string>()
      set.add(session.sessionId)
      sessionSets.set(key, set)
    }
  }
  return [...rows.values()]
    .map((row) => ({ ...row, sessions: sessionSets.get(row.key)?.size ?? 0 }))
    .sort(
      (left, right) => right.totalTokens - left.totalTokens || left.label.localeCompare(right.label)
    )
}

export function buildAntigravityUsageRecentSessions(
  filteredSessions: AntigravityUsageSession[],
  limit: number
): AntigravityUsageSessionRow[] {
  return [...filteredSessions]
    .sort((left, right) => right.lastTimestamp.localeCompare(left.lastTimestamp))
    .slice(0, limit)
    .map((session) => ({
      sessionId: session.sessionId,
      lastActiveAt: session.lastTimestamp,
      durationMinutes: Math.max(
        1,
        Math.round(
          (Date.parse(session.lastTimestamp) - Date.parse(session.firstTimestamp)) / 60_000
        )
      ),
      projectLabel: session.hasMixedLocations
        ? `${session.primaryProjectLabel} + more`
        : session.primaryProjectLabel,
      model: session.hasMixedModels
        ? session.primaryModel
          ? `${session.primaryModel} + more`
          : 'Mixed'
        : session.primaryModel,
      events: session.eventCount,
      inputTokens: session.totalInputTokens,
      cachedInputTokens: session.totalCachedInputTokens,
      outputTokens: session.totalOutputTokens,
      reasoningOutputTokens: session.totalReasoningOutputTokens,
      totalTokens: session.totalTokens
    }))
}
