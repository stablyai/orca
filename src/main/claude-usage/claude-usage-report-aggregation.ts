import type {
  ClaudeUsageBreakdownKind,
  ClaudeUsageBreakdownRow,
  ClaudeUsageDailyPoint,
  ClaudeUsageRange,
  ClaudeUsageScope,
  ClaudeUsageSummary
} from '../../shared/claude-usage-types'
import type { ClaudeUsagePersistedState } from './types'
import { estimateCostUsd } from './claude-model-pricing'
import { getFilteredDaily, getFilteredSessions } from './claude-usage-scope-filters'

export function buildSummary(
  state: ClaudeUsagePersistedState,
  scope: ClaudeUsageScope,
  range: ClaudeUsageRange
): ClaudeUsageSummary {
  const filteredDaily = getFilteredDaily(state, scope, range)
  const filteredSessions = getFilteredSessions(state, scope, range)

  let inputTokens = 0
  let outputTokens = 0
  let cacheReadTokens = 0
  let cacheWriteTokens = 0
  let turns = 0
  let zeroCacheReadTurns = 0
  const byModel = new Map<string, number>()
  const byProject = new Map<string, number>()
  let estimatedCostUsd = 0
  let hasAnyBillableCost = false

  for (const row of filteredDaily) {
    inputTokens += row.inputTokens
    outputTokens += row.outputTokens
    cacheReadTokens += row.cacheReadTokens
    cacheWriteTokens += row.cacheWriteTokens
    turns += row.turnCount
    zeroCacheReadTurns += row.zeroCacheReadTurnCount
    const modelKey = row.model ?? 'Unknown model'
    byModel.set(modelKey, (byModel.get(modelKey) ?? 0) + row.inputTokens + row.outputTokens)
    byProject.set(
      row.projectLabel,
      (byProject.get(row.projectLabel) ?? 0) + row.inputTokens + row.outputTokens
    )
    const cost = estimateCostUsd(
      row.model,
      row.inputTokens,
      row.outputTokens,
      row.cacheReadTokens,
      row.cacheWriteTokens
    )
    if (cost !== null) {
      hasAnyBillableCost = true
      estimatedCostUsd += cost
    }
  }

  const topModel = [...byModel.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null
  const topProject =
    [...byProject.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null

  return {
    scope,
    range,
    sessions: filteredSessions.length,
    turns,
    zeroCacheReadTurns,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheReuseRate:
      inputTokens + cacheReadTokens > 0 ? cacheReadTokens / (inputTokens + cacheReadTokens) : null,
    estimatedCostUsd: hasAnyBillableCost ? estimatedCostUsd : null,
    topModel,
    topProject,
    // Why: the empty-state UX is scope/range specific. Using global persisted
    // data here makes the Orca-only view render empty charts instead of the
    // intended "no usage for this scope" message when only off-Orca logs exist.
    hasAnyClaudeData: filteredSessions.length > 0 || filteredDaily.length > 0
  }
}

export function buildDaily(
  state: ClaudeUsagePersistedState,
  scope: ClaudeUsageScope,
  range: ClaudeUsageRange
): ClaudeUsageDailyPoint[] {
  const byDay = new Map<string, ClaudeUsageDailyPoint>()
  for (const row of getFilteredDaily(state, scope, range)) {
    const existing = byDay.get(row.day) ?? {
      day: row.day,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0
    }
    existing.inputTokens += row.inputTokens
    existing.outputTokens += row.outputTokens
    existing.cacheReadTokens += row.cacheReadTokens
    existing.cacheWriteTokens += row.cacheWriteTokens
    byDay.set(row.day, existing)
  }
  return [...byDay.values()].sort((left, right) => left.day.localeCompare(right.day))
}

export function buildBreakdown(
  state: ClaudeUsagePersistedState,
  scope: ClaudeUsageScope,
  range: ClaudeUsageRange,
  kind: ClaudeUsageBreakdownKind
): ClaudeUsageBreakdownRow[] {
  const rows = new Map<string, ClaudeUsageBreakdownRow>()
  const filteredDaily = getFilteredDaily(state, scope, range)
  const filteredSessions = getFilteredSessions(state, scope, range)

  for (const daily of filteredDaily) {
    const key = kind === 'model' ? (daily.model ?? 'unknown') : daily.projectKey
    const label = kind === 'model' ? (daily.model ?? 'Unknown model') : daily.projectLabel
    const existing = rows.get(key) ?? {
      key,
      label,
      sessions: 0,
      turns: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      estimatedCostUsd: null
    }
    existing.turns += daily.turnCount
    existing.inputTokens += daily.inputTokens
    existing.outputTokens += daily.outputTokens
    existing.cacheReadTokens += daily.cacheReadTokens
    existing.cacheWriteTokens += daily.cacheWriteTokens
    rows.set(key, existing)
  }

  for (const session of filteredSessions) {
    if (kind === 'model') {
      const key = session.model ?? 'unknown'
      const row = rows.get(key)
      if (row) {
        row.sessions++
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
    if (kind === 'model') {
      row.estimatedCostUsd = estimateCostUsd(
        row.key,
        row.inputTokens,
        row.outputTokens,
        row.cacheReadTokens,
        row.cacheWriteTokens
      )
    }
  }

  return [...rows.values()].sort((left, right) => {
    const leftTotal = left.inputTokens + left.outputTokens
    const rightTotal = right.inputTokens + right.outputTokens
    return rightTotal - leftTotal
  })
}
