import type { UsageHistoryProvider, UsageHistoryRow } from '../../shared/usage-history-types'
import type { ClaudeUsageDailyAggregate } from '../claude-usage/types'
import type { CodexUsageDailyAggregate } from '../codex-usage/types'
import type { OpenCodeUsageDailyAggregate } from '../opencode-usage/types'
import type { MuseUsageDailyAggregate } from '../muse-usage/types'
import { estimateCostUsd as claudeCost } from '../claude-usage/claude-model-pricing'
import { estimateCostUsd as codexCost } from '../codex-usage/codex-usage-cost-estimate'

function identity(
  provider: UsageHistoryProvider,
  row: Pick<UsageHistoryRow, 'day' | 'model' | 'projectKey' | 'projectLabel'> & {
    sessionId?: string
    accountId?: string | null
    worktreeId: string | null
  }
) {
  return {
    provider,
    accountId: row.accountId ?? null,
    day: row.day,
    sessionId: row.sessionId ?? null,
    model: row.model,
    projectKey: row.projectKey,
    projectLabel: row.projectLabel,
    inOrca: row.worktreeId !== null
  }
}

export function projectClaudeUsageHistory(rows: ClaudeUsageDailyAggregate[]): UsageHistoryRow[] {
  return rows.map((row) => ({
    ...identity('claude', row),
    newInputTokens: row.inputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    outputTokens: row.outputTokens,
    reasoningTokens: 0,
    activityCount: row.turnCount,
    totalTokens: row.inputTokens + row.cacheReadTokens + row.cacheWriteTokens + row.outputTokens,
    apiEquivalentCostUsd: claudeCost(row.model, row)
  }))
}

export function projectEventUsageHistory(
  provider: Exclude<UsageHistoryProvider, 'claude'>,
  rows: (CodexUsageDailyAggregate | OpenCodeUsageDailyAggregate | MuseUsageDailyAggregate)[]
): UsageHistoryRow[] {
  return rows.map((row) => {
    const cachedInputTokens = Math.min(row.cachedInputTokens, row.inputTokens)
    const cacheWriteTokens = Math.min(
      cachedInputTokens,
      'cacheWriteInputTokens' in row ? (row.cacheWriteInputTokens ?? 0) : 0
    )
    const cacheReadTokens = cachedInputTokens - cacheWriteTokens
    const apiEquivalentCostUsd =
      provider === 'codex' && 'longContextInputTokens' in row ? codexCost(row.model, row) : null
    const outputTokens =
      row.outputTokens + (provider === 'opencode' ? row.reasoningOutputTokens : 0)
    return {
      ...identity(provider, row),
      newInputTokens: Math.max(0, row.inputTokens - cachedInputTokens),
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens,
      reasoningTokens: row.reasoningOutputTokens,
      activityCount: row.eventCount,
      totalTokens: provider === 'opencode' ? row.totalTokens : row.inputTokens + outputTokens,
      // OpenCode's recorded cost is harness telemetry, not an invoice or a price estimate.
      apiEquivalentCostUsd
    }
  })
}
