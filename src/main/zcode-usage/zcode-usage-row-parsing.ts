import { ensureNumber, extractString } from '../usage/usage-record-coercion'
import type { ZcodeUsageRow } from './zcode-usage-row-queries'
import type { ZcodeUsageParsedEvent } from './types'

// Milliseconds in the live schema; the seconds branch guards an older CLI.
function normalizeMillis(value: number | null): number | null {
  if (value === null || value <= 0) {
    return null
  }
  return value < 10_000_000_000 ? value * 1000 : value
}

function extractTimestamp(row: ZcodeUsageRow): string | null {
  const millis = normalizeMillis(row.completed_at) ?? normalizeMillis(row.started_at)
  return millis ? new Date(millis).toISOString() : null
}

/** The account-scoped provider id (`account:bigmodel-individual-coding-plan`) is an
 *  internal handle; users know the model id, so that alone labels the model. */
function extractModelLabel(row: ZcodeUsageRow): string | null {
  return extractString(row.model_id) ?? extractString(row.provider_id)
}

export function parseZcodeUsageRow(row: ZcodeUsageRow): ZcodeUsageParsedEvent | null {
  const timestamp = extractTimestamp(row)
  if (!timestamp) {
    return null
  }

  // `input_tokens` is already the full input; the cache buckets are subsets of it.
  const inputTokens = ensureNumber(row.input_tokens)
  const cacheReadInputTokens = ensureNumber(row.cache_read_input_tokens)
  const cacheWriteInputTokens = ensureNumber(row.cache_creation_input_tokens)
  const cachedInputTokens = cacheReadInputTokens + cacheWriteInputTokens
  const outputTokens = ensureNumber(row.output_tokens)
  const reasoningOutputTokens = ensureNumber(row.reasoning_tokens)
  const totalTokens = Math.max(inputTokens + outputTokens, ensureNumber(row.computed_total_tokens))

  if (totalTokens <= 0) {
    return null
  }

  return {
    sessionId: row.session_id,
    timestamp,
    cwd: extractString(row.directory),
    model: extractModelLabel(row),
    inputTokens,
    cachedInputTokens,
    cacheReadInputTokens,
    cacheWriteInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens
  }
}
