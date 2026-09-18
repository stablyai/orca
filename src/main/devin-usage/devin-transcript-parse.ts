import type { DevinSessionsIndex } from '../ai-vault/session-scanner-devin-db'
import { asRecord } from '../ai-vault/session-scanner-record-value'
import { sessionIdFromFileName } from '../ai-vault/session-scanner-accumulator'
import { arrayValue, extractString } from '../ai-vault/session-scanner-values'
import { numberValue } from '../ai-vault/session-scanner-token-values'
import type { DevinUsageParsedEvent } from './types'

export type DevinTranscriptUsageParse = {
  sessionId: string
  /** True when sessions.db marks the session hidden in Devin's own UI. */
  hidden: boolean
  events: DevinUsageParsedEvent[]
}

const DEVIN_INPUT_KEYS = ['total_input_tokens', 'input_tokens', 'prompt_tokens'] as const
const DEVIN_OUTPUT_KEYS = ['output_tokens', 'completion_tokens'] as const
const DEVIN_CACHE_READ_KEYS = [
  'cache_read_tokens',
  'cache_read_input_tokens',
  'cached_tokens'
] as const
const DEVIN_CACHE_WRITE_KEYS = ['cache_creation_tokens', 'cache_creation_input_tokens'] as const
const DEVIN_REASONING_KEYS = ['reasoning_tokens', 'reasoning_output_tokens'] as const

/**
 * Read one metric bucket from the first source that reports a positive value,
 * so a step carrying both legacy metadata metrics and ATIF step-level metrics
 * never double-counts. Mirrors the AI Vault's devinStepTokenTotal sources.
 */
function firstDevinMetric(
  sources: readonly (Record<string, unknown> | null)[],
  keys: readonly string[]
): { value: number; key: string | null } {
  for (const source of sources) {
    if (!source) {
      continue
    }
    for (const key of keys) {
      const value = numberValue(source[key])
      if (value > 0) {
        return { value, key }
      }
    }
  }
  return { value: 0, key: null }
}

/**
 * Fold one ATIF transcript into usage events. Devin reports metrics per LLM
 * step: `prompt_tokens`/`cached_tokens`/`completion_tokens` (ATIF ≥1.7, where
 * cached is a subset of prompt) or the legacy `input_tokens`/`output_tokens`/
 * `cache_*` split (where cache is additive). Both are normalized so
 * `cached ⊆ input` and `total = input + output` hold for every event.
 */
export function parseDevinTranscriptForUsage(
  filePath: string,
  content: string,
  sessionsIndex: DevinSessionsIndex | null
): DevinTranscriptUsageParse | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  const record = asRecord(parsed)
  if (!record) {
    return null
  }
  const sessionId =
    extractString(record.session_id) ??
    extractString(record.sessionId) ??
    sessionIdFromFileName(filePath)
  const dbRow = sessionsIndex?.get(sessionId) ?? sessionsIndex?.get(sessionIdFromFileName(filePath))
  const agentRecord = asRecord(record.agent)
  const sessionModel =
    extractString(agentRecord?.model_name) ??
    extractString(agentRecord?.model) ??
    extractString(record.generation_model) ??
    dbRow?.model ??
    null
  // Why: Windows transcripts carry no cwd; the sessions.db row is the
  // attribution source there (same as the AI Vault merge).
  const sessionCwd = extractString(record.working_directory) ?? dbRow?.workingDirectory ?? null

  const events: DevinUsageParsedEvent[] = []
  for (const step of arrayValue(record.steps)) {
    const stepRecord = asRecord(step)
    if (!stepRecord) {
      continue
    }
    const metadata = asRecord(stepRecord.metadata)
    const sources = [metadata, asRecord(metadata?.metrics), asRecord(stepRecord.metrics)]
    const input = firstDevinMetric(sources, DEVIN_INPUT_KEYS)
    const output = firstDevinMetric(sources, DEVIN_OUTPUT_KEYS)
    const cacheRead = firstDevinMetric(sources, DEVIN_CACHE_READ_KEYS)
    const cacheWrite = firstDevinMetric(sources, DEVIN_CACHE_WRITE_KEYS)
    const reasoning = firstDevinMetric(sources, DEVIN_REASONING_KEYS)
    const cachedTokens = cacheRead.value + cacheWrite.value
    // prompt_tokens/total_input_tokens already include cache; the legacy
    // input_tokens split does not, so additive cache buckets fold into input
    // to keep cached ⊆ input.
    const inputTokens =
      input.key === 'prompt_tokens' || input.key === 'total_input_tokens'
        ? input.value
        : input.value + cachedTokens
    const outputTokens = output.value
    const totalTokens = inputTokens + outputTokens
    if (totalTokens <= 0) {
      continue
    }
    const timestamp = extractString(stepRecord.timestamp) ?? extractString(metadata?.created_at)
    if (!timestamp) {
      continue
    }
    const extra = asRecord(stepRecord.extra)
    const metrics = asRecord(stepRecord.metrics)
    events.push({
      sessionId,
      timestamp,
      model:
        extractString(stepRecord.model_name) ??
        extractString(extra?.generation_model) ??
        extractString(metadata?.generation_model) ??
        extractString(metrics?.generation_model) ??
        sessionModel,
      cwd: sessionCwd,
      estimatedCostUsd: null,
      inputTokens,
      cachedInputTokens: Math.min(cachedTokens, inputTokens),
      outputTokens,
      reasoningOutputTokens: reasoning.value,
      totalTokens
    })
  }

  return { sessionId, hidden: dbRow?.hidden === true, events }
}
