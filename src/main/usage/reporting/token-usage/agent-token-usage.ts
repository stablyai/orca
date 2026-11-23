import type { AgentTokenCounts } from '../../../../shared/telemetry/schemas/telemetry-agent-token-usage-schema'
import type { ClaudeUsageDailyAggregate } from '../../../claude-usage/types'
import type { CodexUsageDailyAggregate } from '../../../codex-usage/types'
import type { OpenCodeUsageDailyAggregate } from '../../../opencode-usage/types'

/** Tokens Orca worktrees used on one local calendar day. */
export type AgentTokenDay = AgentTokenCounts & { day: string }

function sumByDay<Row extends { day: string; worktreeId: string | null }>(
  rows: Row[],
  counts: (row: Row) => AgentTokenCounts
): AgentTokenDay[] {
  const byDay = new Map<string, AgentTokenDay>()
  for (const row of rows) {
    if (row.worktreeId === null) {
      continue
    }
    const add = counts(row)
    const total = byDay.get(row.day) ?? {
      day: row.day,
      input_tokens: 0,
      output_tokens: 0,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0
    }
    total.input_tokens += Math.max(0, add.input_tokens)
    total.output_tokens += Math.max(0, add.output_tokens)
    total.cached_input_tokens += Math.max(0, add.cached_input_tokens)
    total.cache_write_input_tokens += Math.max(0, add.cache_write_input_tokens)
    byDay.set(row.day, total)
  }
  return [...byDay.values()]
}

export function claudeTokenDays(rows: ClaudeUsageDailyAggregate[]): AgentTokenDay[] {
  return sumByDay(rows, (row) => ({
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    cached_input_tokens: row.cacheReadTokens,
    cache_write_input_tokens: row.cacheWriteTokens
  }))
}

export function codexOpenCodeTokenDays(
  rows: (CodexUsageDailyAggregate | OpenCodeUsageDailyAggregate)[]
): AgentTokenDay[] {
  return sumByDay(rows, (row) => {
    const cacheWrite = 'cacheWriteInputTokens' in row ? (row.cacheWriteInputTokens ?? 0) : 0
    // Codex/OpenCode include cache hits in input; Claude records them separately.
    return {
      input_tokens: row.inputTokens - row.cachedInputTokens,
      output_tokens: row.outputTokens,
      cached_input_tokens: row.cachedInputTokens - cacheWrite,
      cache_write_input_tokens: cacheWrite
    }
  })
}
