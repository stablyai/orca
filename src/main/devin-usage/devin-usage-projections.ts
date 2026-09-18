import { highestUsageKey } from '../usage/highest-usage-key'
import { filterUsageDaily, filterUsageSessions } from '../usage/usage-scope-filters'
import type {
  DevinUsageBreakdownKind,
  DevinUsageBreakdownRow,
  DevinUsageDailyPoint,
  DevinUsageRange,
  DevinUsageScope,
  DevinUsageSessionRow,
  DevinUsageSummary
} from '../../shared/devin-usage-types'
import type { DevinUsagePersistedState } from './types'

function filteredDaily(
  state: DevinUsagePersistedState,
  scope: DevinUsageScope,
  range: DevinUsageRange
) {
  return filterUsageDaily(state.dailyAggregates, scope, range)
}

function filteredSessions(
  state: DevinUsagePersistedState,
  scope: DevinUsageScope,
  range: DevinUsageRange
) {
  return filterUsageSessions(state.sessions, scope, range)
}

export function buildDevinSummary(
  state: DevinUsagePersistedState,
  scope: DevinUsageScope,
  range: DevinUsageRange
): DevinUsageSummary {
  const daily = filteredDaily(state, scope, range)
  const sessions = filteredSessions(state, scope, range)
  let inputTokens = 0
  let cachedInputTokens = 0
  let outputTokens = 0
  let totalTokens = 0
  let events = 0
  const byModel = new Map<string, number>()
  const byProject = new Map<string, number>()
  for (const row of daily) {
    inputTokens += row.inputTokens
    cachedInputTokens += row.cachedInputTokens
    outputTokens += row.outputTokens
    totalTokens += row.totalTokens
    events += row.eventCount
    const model = row.model ?? 'Unknown model'
    byModel.set(model, (byModel.get(model) ?? 0) + row.totalTokens)
    byProject.set(row.projectLabel, (byProject.get(row.projectLabel) ?? 0) + row.totalTokens)
  }
  return {
    scope,
    range,
    sessions: sessions.length,
    events,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens: 0,
    totalTokens,
    estimatedCostUsd: null,
    topModel: highestUsageKey(byModel),
    topProject: highestUsageKey(byProject),
    hasAnyDevinData: sessions.length > 0 || daily.length > 0
  }
}

export function buildDevinDaily(
  state: DevinUsagePersistedState,
  scope: DevinUsageScope,
  range: DevinUsageRange
): DevinUsageDailyPoint[] {
  const rows = new Map<string, DevinUsageDailyPoint>()
  for (const entry of filteredDaily(state, scope, range)) {
    const row = rows.get(entry.day) ?? {
      day: entry.day,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0
    }
    row.inputTokens += entry.inputTokens
    row.cachedInputTokens += entry.cachedInputTokens
    row.outputTokens += entry.outputTokens
    row.totalTokens += entry.totalTokens
    rows.set(entry.day, row)
  }
  return [...rows.values()].sort((a, b) => a.day.localeCompare(b.day))
}

export function buildDevinBreakdown(
  state: DevinUsagePersistedState,
  scope: DevinUsageScope,
  range: DevinUsageRange,
  kind: DevinUsageBreakdownKind
): DevinUsageBreakdownRow[] {
  const rows = new Map<string, DevinUsageBreakdownRow>()
  for (const entry of filteredDaily(state, scope, range)) {
    const key = kind === 'model' ? (entry.model ?? 'unknown') : entry.projectKey
    const row = rows.get(key) ?? {
      key,
      label: kind === 'model' ? (entry.model ?? 'Unknown model') : entry.projectLabel,
      sessions: 0,
      events: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      estimatedCostUsd: null,
      hasInferredPricing: false
    }
    row.events += entry.eventCount
    row.inputTokens += entry.inputTokens
    row.cachedInputTokens += entry.cachedInputTokens
    row.outputTokens += entry.outputTokens
    row.totalTokens += entry.totalTokens
    rows.set(key, row)
  }
  for (const session of filteredSessions(state, scope, range)) {
    const seen = new Set<string>()
    if (kind === 'model') {
      for (const entry of session.modelBreakdown) {
        if (seen.has(entry.modelKey)) {
          continue
        }
        const row = rows.get(entry.modelKey)
        if (row) {
          row.sessions++
        }
        seen.add(entry.modelKey)
      }
      continue
    }
    for (const entry of session.locationBreakdown) {
      if (scope === 'orca' && entry.worktreeId === null) {
        continue
      }
      if (seen.has(entry.locationKey)) {
        continue
      }
      const row = rows.get(entry.locationKey)
      if (row) {
        row.sessions++
      }
      seen.add(entry.locationKey)
    }
  }
  return [...rows.values()].sort((a, b) => b.totalTokens - a.totalTokens)
}

export function buildDevinRecentSessions(
  state: DevinUsagePersistedState,
  scope: DevinUsageScope,
  range: DevinUsageRange,
  limit: number
): DevinUsageSessionRow[] {
  return filteredSessions(state, scope, range)
    .slice(0, limit)
    .map((session) => {
      const locations = session.locationBreakdown.filter(
        (entry) => scope === 'all' || entry.worktreeId !== null
      )
      return {
        sessionId: session.sessionId,
        lastActiveAt: session.lastTimestamp,
        durationMinutes: Math.max(
          0,
          Math.round(
            (Date.parse(session.lastTimestamp) - Date.parse(session.firstTimestamp)) / 60_000
          )
        ),
        projectLabel:
          locations.length > 1
            ? 'Multiple locations'
            : (locations[0]?.projectLabel ?? session.primaryProjectLabel),
        model: session.primaryModel,
        events: locations.reduce((sum, entry) => sum + entry.eventCount, 0),
        inputTokens: locations.reduce((sum, entry) => sum + entry.inputTokens, 0),
        cachedInputTokens: locations.reduce((sum, entry) => sum + entry.cachedInputTokens, 0),
        outputTokens: locations.reduce((sum, entry) => sum + entry.outputTokens, 0),
        reasoningOutputTokens: 0,
        totalTokens: locations.reduce((sum, entry) => sum + entry.totalTokens, 0),
        hasInferredPricing: false
      }
    })
}
