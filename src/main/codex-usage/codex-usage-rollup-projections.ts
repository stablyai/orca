import { highestUsageKey } from '../usage/highest-usage-key'
import type {
  CodexUsageBreakdownKind,
  CodexUsageBreakdownRow,
  CodexUsageDailyPoint,
  CodexUsageRange,
  CodexUsageScope,
  CodexUsageSummary
} from '../../shared/codex-usage-types'
import type { CodexLongContextTokens, CodexUsagePersistedState } from './types'
import { estimateCostUsd } from './codex-usage-cost-estimate'
import {
  getFilteredDaily,
  getFilteredSessions,
  getScopedSessionModels
} from './codex-usage-scope-filters'

export function buildSummary(
  state: CodexUsagePersistedState,
  scope: CodexUsageScope,
  range: CodexUsageRange
): CodexUsageSummary {
  const filteredDaily = getFilteredDaily(state, scope, range)
  const filteredSessions = getFilteredSessions(state, scope, range)

  let inputTokens = 0
  let cachedInputTokens = 0
  let outputTokens = 0
  let reasoningOutputTokens = 0
  let totalTokens = 0
  let events = 0
  let estimatedCostUsd = 0
  let hasAnyBillableCost = false
  let hasUnpricedModels = false
  const byModel = new Map<string, number>()
  const byProject = new Map<string, number>()

  for (const row of filteredDaily) {
    inputTokens += row.inputTokens
    cachedInputTokens += row.cachedInputTokens
    outputTokens += row.outputTokens
    reasoningOutputTokens += row.reasoningOutputTokens
    totalTokens += row.totalTokens
    events += row.eventCount
    byModel.set(
      row.model ?? 'Unknown model',
      (byModel.get(row.model ?? 'Unknown model') ?? 0) + row.totalTokens
    )
    byProject.set(row.projectLabel, (byProject.get(row.projectLabel) ?? 0) + row.totalTokens)
    const cost = estimateCostUsd(row.model, row)
    if (cost !== null) {
      hasAnyBillableCost = true
      estimatedCostUsd += cost
    } else if (row.model !== null) {
      // A named model with no pricing entry: its tokens silently leave the total.
      hasUnpricedModels = true
    }
  }

  const topModel = highestUsageKey(byModel)
  const topProject = highestUsageKey(byProject)

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
    estimatedCostUsd: hasAnyBillableCost ? estimatedCostUsd : null,
    hasUnpricedModels,
    topModel,
    topProject,
    hasAnyCodexData: filteredSessions.length > 0 || filteredDaily.length > 0
  }
}

export function buildDaily(
  state: CodexUsagePersistedState,
  scope: CodexUsageScope,
  range: CodexUsageRange
): CodexUsageDailyPoint[] {
  const byDay = new Map<string, CodexUsageDailyPoint>()
  for (const row of getFilteredDaily(state, scope, range)) {
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
  state: CodexUsagePersistedState,
  scope: CodexUsageScope,
  range: CodexUsageRange,
  kind: CodexUsageBreakdownKind
): CodexUsageBreakdownRow[] {
  const rows = new Map<string, CodexUsageBreakdownRow>()
  // Why: long-context counts price the row but are not part of the renderer-facing row shape.
  const longContextByKey = new Map<string, CodexLongContextTokens>()
  const filteredDaily = getFilteredDaily(state, scope, range)
  if (filteredDaily.length === 0) {
    return []
  }
  const filteredSessions = getFilteredSessions(state, scope, range)

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
      estimatedCostUsd: null,
      hasInferredPricing: false
    }
    existing.events += daily.eventCount
    existing.inputTokens += daily.inputTokens
    existing.cachedInputTokens += daily.cachedInputTokens
    existing.outputTokens += daily.outputTokens
    existing.reasoningOutputTokens += daily.reasoningOutputTokens
    existing.totalTokens += daily.totalTokens
    existing.hasInferredPricing ||= daily.hasInferredPricing
    rows.set(key, existing)
    const longContext = longContextByKey.get(key) ?? {
      longContextInputTokens: 0,
      longContextCachedInputTokens: 0,
      longContextOutputTokens: 0
    }
    longContext.longContextInputTokens += daily.longContextInputTokens
    longContext.longContextCachedInputTokens += daily.longContextCachedInputTokens
    longContext.longContextOutputTokens += daily.longContextOutputTokens
    longContextByKey.set(key, longContext)
  }

  for (const session of filteredSessions) {
    if (kind === 'model') {
      const seen = new Set<string>()
      for (const model of getScopedSessionModels(session, scope)) {
        if (seen.has(model.modelKey)) {
          continue
        }
        seen.add(model.modelKey)
        const row = rows.get(model.modelKey)
        if (row) {
          row.sessions++
        }
      }
      continue
    }
    const matchingLocations = session.locationBreakdown.filter((entry) =>
      scope === 'all' ? true : entry.worktreeId !== null
    )
    const seen = new Set<string>()
    for (const location of matchingLocations) {
      if (seen.has(location.locationKey)) {
        continue
      }
      seen.add(location.locationKey)
      const row = rows.get(location.locationKey)
      if (row) {
        row.sessions++
      }
    }
  }

  for (const row of rows.values()) {
    const longContext = longContextByKey.get(row.key)
    row.estimatedCostUsd =
      kind === 'model' && longContext ? estimateCostUsd(row.key, { ...row, ...longContext }) : null
  }

  return [...rows.values()].sort((left, right) => right.totalTokens - left.totalTokens)
}
