import { highestUsageKey } from '../usage/highest-usage-key'
import {
  getScopedDevinSessionModels,
  getScopedDevinSessionPrimaryModel
} from './scope-range-filter'
import type {
  DevinUsageBreakdownKind,
  DevinUsageBreakdownRow,
  DevinUsageDailyPoint,
  DevinUsageRange,
  DevinUsageScope,
  DevinUsageSessionRow,
  DevinUsageSummary
} from '../../shared/devin-usage-types'
import type { DevinUsageDailyAggregate, DevinUsageSession } from './types'

function addCost(left: number | null, right: number | null): number | null {
  if (left === null && right === null) {
    return null
  }
  return (left ?? 0) + (right ?? 0)
}

export function buildDevinUsageSummary(
  scope: DevinUsageScope,
  range: DevinUsageRange,
  filteredDaily: DevinUsageDailyAggregate[],
  filteredSessions: DevinUsageSession[]
): DevinUsageSummary {
  let inputTokens = 0
  let cachedInputTokens = 0
  let outputTokens = 0
  let reasoningOutputTokens = 0
  let totalTokens = 0
  let events = 0
  let estimatedCostUsd: number | null = null
  const byModel = new Map<string, number>()
  // Why: projectLabel is not unique — two worktrees can share a display name
  // like 'main'. Group by projectKey and keep the label for display.
  const byProject = new Map<string, number>()
  const projectLabelByKey = new Map<string, string>()

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
    byProject.set(row.projectKey, (byProject.get(row.projectKey) ?? 0) + row.totalTokens)
    projectLabelByKey.set(row.projectKey, row.projectLabel)
  }

  const topModel = highestUsageKey(byModel)
  const topProjectKey = highestUsageKey(byProject)
  const topProject = topProjectKey === null ? null : (projectLabelByKey.get(topProjectKey) ?? null)

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
    cacheShare: inputTokens > 0 ? cachedInputTokens / inputTokens : 0,
    topModel,
    topProject,
    hasAnyDevinData: filteredSessions.length > 0 || filteredDaily.length > 0
  }
}

export function buildDevinUsageDailyPoints(
  filteredDaily: DevinUsageDailyAggregate[]
): DevinUsageDailyPoint[] {
  const byDay = new Map<string, DevinUsageDailyPoint>()
  for (const row of filteredDaily) {
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

export function buildDevinUsageBreakdownRows(
  kind: DevinUsageBreakdownKind,
  filteredDaily: DevinUsageDailyAggregate[],
  filteredSessions: DevinUsageSession[],
  scope: DevinUsageScope
): DevinUsageBreakdownRow[] {
  const rows = new Map<string, DevinUsageBreakdownRow>()

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

  // Why: session counts respect the scope — under 'orca' a session counts
  // toward a model/location only through its worktree-attributed share.
  if (kind === 'model') {
    for (const session of filteredSessions) {
      const seen = new Set<string>()
      for (const entry of getScopedDevinSessionModels(session, scope)) {
        if (seen.has(entry.modelKey)) {
          continue
        }
        seen.add(entry.modelKey)
        const row = rows.get(entry.modelKey)
        if (row) {
          row.sessions++
        }
      }
    }
  } else {
    for (const session of filteredSessions) {
      const seen = new Set<string>()
      for (const entry of session.locationBreakdown) {
        if (scope === 'orca' && entry.worktreeId === null) {
          continue
        }
        if (seen.has(entry.locationKey)) {
          continue
        }
        seen.add(entry.locationKey)
        const row = rows.get(entry.locationKey)
        if (row) {
          row.sessions++
        }
      }
    }
  }

  return [...rows.values()].sort((left, right) => right.totalTokens - left.totalTokens)
}

export function buildDevinUsageRecentSessions(
  filteredSessions: DevinUsageSession[],
  scope: DevinUsageScope,
  limit = 10
): DevinUsageSessionRow[] {
  return filteredSessions.slice(0, limit).map((session): DevinUsageSessionRow => {
    // Why: under 'orca' the row shows only the worktree-attributed share of a
    // mixed-location session — same projection the Codex provider applies.
    const matchingLocations = session.locationBreakdown.filter((entry) =>
      scope === 'all' ? true : entry.worktreeId !== null
    )
    const scopedLocations =
      matchingLocations.length > 0 ? matchingLocations : session.locationBreakdown
    const totals = scopedLocations.reduce(
      (acc, entry) => {
        acc.events += entry.eventCount
        acc.inputTokens += entry.inputTokens
        acc.cachedInputTokens += entry.cachedInputTokens
        acc.outputTokens += entry.outputTokens
        acc.reasoningOutputTokens += entry.reasoningOutputTokens
        acc.totalTokens += entry.totalTokens
        return acc
      },
      {
        events: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0
      }
    )
    return {
      sessionId: session.sessionId,
      lastActiveAt: session.lastTimestamp,
      durationMinutes: Math.max(
        0,
        Math.round(
          (new Date(session.lastTimestamp).getTime() - new Date(session.firstTimestamp).getTime()) /
            60_000
        )
      ),
      projectLabel:
        scopedLocations.length > 1
          ? 'Multiple locations'
          : (scopedLocations[0]?.projectLabel ?? session.primaryProjectLabel),
      model: getScopedDevinSessionPrimaryModel(session, scope),
      events: totals.events,
      inputTokens: totals.inputTokens,
      cachedInputTokens: totals.cachedInputTokens,
      outputTokens: totals.outputTokens,
      reasoningOutputTokens: totals.reasoningOutputTokens,
      totalTokens: totals.totalTokens
    }
  })
}
