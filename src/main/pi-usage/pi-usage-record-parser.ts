import { record, type JsonRecord } from '../../shared/codex-rollout-jsonl-cursor'
import { isOmpWrittenRecord } from '../ai-vault/scanners/omp/session-scanner-omp-written-record'
import { ensureNumber, extractString } from '../usage/usage-record-coercion'
import type { PiUsageParsedEvent } from './types'

export type PiUsageParseContext = {
  sessionId: string
  cwd: string | null
  /** OMP inherits PI_CODING_AGENT_DIR, so its logs can share Pi's folder. */
  isOmpLog: boolean
}

// Skip tool output and user turns; keep usage, session context, and OMP markers.
const LINE_MARKERS = ['"usage"', '"session"', '"model_change"', '"title"', '"runtime"']

function lineMayMatter(line: string): boolean {
  return LINE_MARKERS.some((marker) => line.includes(marker))
}

function messageTimestampIso(entry: JsonRecord, message: JsonRecord): string | null {
  const millis = message.timestamp
  const date =
    typeof millis === 'number' && Number.isFinite(millis) && millis > 0
      ? new Date(millis)
      : new Date(extractString(entry.timestamp) ?? Number.NaN)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function modelLabel(message: JsonRecord): string | null {
  const model = extractString(message.model)
  const provider = extractString(message.provider)
  // One model id can be served by several user-configured providers.
  return model && provider ? `${provider}/${model}` : model
}

function toUsageEvent(entry: JsonRecord, context: PiUsageParseContext): PiUsageParsedEvent | null {
  if (entry.type !== 'message') {
    return null
  }
  const message = record(entry.message)
  const usage = record(message?.usage)
  if (!message || message.role !== 'assistant' || !usage) {
    return null
  }
  const timestamp = messageTimestampIso(entry, message)
  if (!timestamp) {
    return null
  }
  const uncachedInputTokens = ensureNumber(usage.input)
  const cacheReadTokens = ensureNumber(usage.cacheRead)
  const cacheWriteTokens = ensureNumber(usage.cacheWrite)
  // Pi reports input without cache reads or writes; Orca counts cache reads as a subset of input.
  const inputTokens = uncachedInputTokens + cacheReadTokens + cacheWriteTokens
  const outputTokens = ensureNumber(usage.output)
  // Reasoning is a subset of output; clamp malformed records to avoid negative derived counts.
  const reasoningOutputTokens = Math.min(ensureNumber(usage.reasoning), outputTokens)
  const totalTokens = inputTokens + outputTokens
  if (totalTokens === 0) {
    return null
  }
  // Unpriced models record a zero cost; treat that as unknown, like OpenCode's recorded cost.
  const cost = ensureNumber(record(usage.cost)?.total)
  return {
    sessionId: context.sessionId,
    timestamp,
    // Content keys deduplicate fork copies, which keep the original response timestamps.
    eventKey: [
      timestamp,
      extractString(message.responseId) ?? '',
      uncachedInputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      outputTokens
    ].join(':'),
    model: modelLabel(message),
    cwd: context.cwd,
    inputTokens,
    cachedInputTokens: cacheReadTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
    estimatedCostUsd: cost > 0 ? cost : null
  }
}

export function parsePiUsageLine(line: string, context: PiUsageParseContext): PiUsageParsedEvent[] {
  if (context.isOmpLog || !lineMayMatter(line)) {
    return []
  }
  let entry: JsonRecord | undefined
  try {
    entry = record(JSON.parse(line))
  } catch {
    return []
  }
  if (!entry) {
    return []
  }
  if (isOmpWrittenRecord(entry)) {
    context.isOmpLog = true
    return []
  }
  if (entry.type === 'session') {
    context.sessionId = extractString(entry.id) ?? context.sessionId
    context.cwd = extractString(entry.cwd) ?? context.cwd
    return []
  }
  const event = toUsageEvent(entry, context)
  return event ? [event] : []
}
