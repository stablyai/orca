import { highestUsageKey } from '../usage/rollups/highest-usage-key'
import type {
  MistralVibeUsageBreakdownKind,
  MistralVibeUsageBreakdownRow,
  MistralVibeUsageDailyPoint,
  MistralVibeUsageRange,
  MistralVibeUsageScope,
  MistralVibeUsageSessionRow,
  MistralVibeUsageSummary
} from '../../shared/mistral-vibe-usage-types'
import type { MistralVibeUsageDailyAggregate, MistralVibeUsageSession } from './types'

type TokenTotals = Pick<
  MistralVibeUsageDailyPoint,
  'inputTokens' | 'cachedInputTokens' | 'outputTokens' | 'reasoningOutputTokens' | 'totalTokens'
>

type CostTotals = { estimatedCostUsd: number | null; hasUnpricedModels: boolean }

function emptyTotals(): TokenTotals {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0
  }
}

function addTotals(target: TokenTotals, row: TokenTotals): void {
  target.inputTokens += row.inputTokens
  target.cachedInputTokens += row.cachedInputTokens
  target.outputTokens += row.outputTokens
  target.reasoningOutputTokens += row.reasoningOutputTokens
  target.totalTokens += row.totalTokens
}

function addCost(target: CostTotals, row: CostTotals): void {
  if (row.estimatedCostUsd !== null) {
    target.estimatedCostUsd = (target.estimatedCostUsd ?? 0) + row.estimatedCostUsd
  }
  target.hasUnpricedModels ||= row.hasUnpricedModels
}

export function buildMistralVibeUsageSummary(
  scope: MistralVibeUsageScope,
  range: MistralVibeUsageRange,
  filteredDaily: MistralVibeUsageDailyAggregate[],
  filteredSessions: MistralVibeUsageSession[]
): MistralVibeUsageSummary {
  const totals = emptyTotals()
  const cost: CostTotals = { estimatedCostUsd: null, hasUnpricedModels: false }
  let events = 0
  const byModel = new Map<string, number>()
  const byProject = new Map<string, number>()
  for (const row of filteredDaily) {
    addTotals(totals, row)
    addCost(cost, row)
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
    ...cost,
    topModel: highestUsageKey(byModel),
    topProject: highestUsageKey(byProject),
    hasAnyMistralVibeData: filteredSessions.length > 0 || filteredDaily.length > 0
  }
}

export function buildMistralVibeUsageDailyPoints(
  filteredDaily: MistralVibeUsageDailyAggregate[]
): MistralVibeUsageDailyPoint[] {
  const byDay = new Map<string, MistralVibeUsageDailyPoint>()
  for (const row of filteredDaily) {
    const existing = byDay.get(row.day) ?? { day: row.day, ...emptyTotals() }
    addTotals(existing, row)
    byDay.set(row.day, existing)
  }
  return [...byDay.values()].sort((left, right) => left.day.localeCompare(right.day))
}

export function buildMistralVibeUsageBreakdownRows(
  kind: MistralVibeUsageBreakdownKind,
  scope: MistralVibeUsageScope,
  filteredDaily: MistralVibeUsageDailyAggregate[],
  filteredSessions: MistralVibeUsageSession[]
): MistralVibeUsageBreakdownRow[] {
  const rows = new Map<string, MistralVibeUsageBreakdownRow>()
  for (const daily of filteredDaily) {
    const key = kind === 'model' ? (daily.model ?? 'unknown') : daily.projectKey
    const label = kind === 'model' ? (daily.model ?? 'Unknown model') : daily.projectLabel
    const existing = rows.get(key) ?? {
      key,
      label,
      sessions: 0,
      events: 0,
      ...emptyTotals(),
      estimatedCostUsd: null,
      hasUnpricedModels: false
    }
    existing.events += daily.eventCount
    addTotals(existing, daily)
    addCost(existing, daily)
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

export function buildMistralVibeUsageRecentSessions(
  filteredSessions: MistralVibeUsageSession[],
  limit = 10
): MistralVibeUsageSessionRow[] {
  return filteredSessions.slice(0, limit).map((session) => ({
    sessionId: session.sessionId,
    lastActiveAt: session.lastTimestamp,
    projectLabel: session.primaryProjectLabel,
    model: session.primaryModel,
    events: session.eventCount,
    inputTokens: session.totalInputTokens,
    cachedInputTokens: session.totalCachedInputTokens,
    outputTokens: session.totalOutputTokens,
    reasoningOutputTokens: session.totalReasoningOutputTokens,
    totalTokens: session.totalTokens,
    estimatedCostUsd: session.estimatedCostUsd
  }))
}
