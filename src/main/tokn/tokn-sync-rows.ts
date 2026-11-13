import type { ToknSyncRow } from '../../shared/tokn-sync-status'
import type { ClaudeUsageDailyAggregate } from '../claude-usage/types'
import type { CodexUsageDailyAggregate } from '../codex-usage/types'
import { estimateCostUsd as estimateClaudeCostUsd } from '../claude-usage/claude-model-pricing'
import { estimateCostUsd as estimateCodexCostUsd } from '../codex-usage/codex-usage-cost-estimate'

// tokn's sync endpoint refuses larger uploads.
const MAX_ROWS = 20_000

/**
 * Mirrors the tokn CLI's normalizeModel. tokn upserts on (day, tool, model), so a
 * different spelling would make Orca and the tokn CLI count the same usage twice.
 */
export function normalizeToknModel(raw: string): string {
  let id = raw.trim().toLowerCase()
  id = id.replace(/^(us|eu|apac|global|ca|sa|apne|usgov)\./, '')
  id = id.replace(/^anthropic\./, '')
  id = id.replace(/^[a-z0-9-]+\//, '')
  id = id.replace(/-v\d+(?::\d+)?$/, '')
  const at = id.indexOf('@')
  if (at !== -1) {
    id = id.slice(0, at)
  }
  return id.replace(/-\d{8}$/, '')
}

type RowTotals = Omit<ToknSyncRow, 'day' | 'tool' | 'model' | 'fast'>

function addToBucket(
  buckets: Map<string, ToknSyncRow>,
  day: string,
  tool: ToknSyncRow['tool'],
  rawModel: string | null,
  totals: RowTotals
): void {
  // Client-generated placeholders like `<synthetic>` never reached an API.
  if (!rawModel || rawModel.startsWith('<')) {
    return
  }
  const model = normalizeToknModel(rawModel)
  if (!model) {
    return
  }
  const key = `${day}\u0000${tool}\u0000${model}`
  const row = buckets.get(key) ?? {
    day,
    tool,
    model,
    requests: 0,
    input: 0,
    output: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    cacheRead: 0,
    costUsd: 0,
    fast: false
  }
  row.requests += totals.requests
  row.input += totals.input
  row.output += totals.output
  row.cacheWrite5m += totals.cacheWrite5m
  row.cacheWrite1h += totals.cacheWrite1h
  row.cacheRead += totals.cacheRead
  row.costUsd += totals.costUsd
  buckets.set(key, row)
}

/** Collapses Orca's per-project daily rollups into tokn's per-model day totals. */
export function buildToknSyncRows(usage: {
  claude: readonly ClaudeUsageDailyAggregate[]
  codex: readonly CodexUsageDailyAggregate[]
}): ToknSyncRow[] {
  const buckets = new Map<string, ToknSyncRow>()
  for (const entry of usage.claude) {
    addToBucket(buckets, entry.day, 'claude-code', entry.model, {
      requests: entry.turnCount,
      input: entry.inputTokens,
      output: entry.outputTokens,
      // Orca counts the 1-hour writes inside cacheWriteTokens; tokn prices the tiers separately.
      cacheWrite5m: Math.max(0, entry.cacheWriteTokens - entry.cacheWrite1hTokens),
      cacheWrite1h: entry.cacheWrite1hTokens,
      cacheRead: entry.cacheReadTokens,
      costUsd: estimateClaudeCostUsd(entry.model, entry) ?? 0
    })
  }
  for (const entry of usage.codex) {
    const cached = Math.min(entry.cachedInputTokens, entry.inputTokens)
    addToBucket(buckets, entry.day, 'codex', entry.model, {
      requests: entry.eventCount,
      // Codex input includes the cached share; tokn bills that share at the cache-read rate.
      input: entry.inputTokens - cached,
      output: entry.outputTokens,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      cacheRead: cached,
      costUsd: estimateCodexCostUsd(entry.model, entry) ?? 0
    })
  }
  const rows = [...buckets.values()]
    .filter(
      (row) => row.input + row.output + row.cacheRead + row.cacheWrite5m + row.cacheWrite1h > 0
    )
    .map((row) => ({ ...row, costUsd: Number(row.costUsd.toFixed(6)) }))
    .sort(
      (a, b) =>
        a.day.localeCompare(b.day) || a.tool.localeCompare(b.tool) || a.model.localeCompare(b.model)
    )
  // Keep the most recent days when a long history outgrows one upload.
  return rows.length > MAX_ROWS ? rows.slice(rows.length - MAX_ROWS) : rows
}
