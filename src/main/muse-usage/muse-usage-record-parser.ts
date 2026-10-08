import { record, type JsonRecord } from '../../shared/codex-rollout-jsonl-cursor'
import { unwrapMuseLogRecords } from '../../shared/muse-session-log'
import { ensureNumber, extractString } from '../usage/usage-record-coercion'
import type { MuseUsageParsedEvent } from './types'

export type MuseUsageParseContext = {
  sessionId: string
  cwd: string | null
  /** Latest configured model; `model_completed` omits `model` on some turns. */
  currentModel: string | null
}

// Why: most lines are large tool/model payloads; skip JSON.parse for lines that
// cannot carry a usage event or the cwd/model context those events need.
const LINE_MARKERS = [
  'model_completed',
  'runtime.session.metadata',
  'runtime.session.route_facts',
  'run.model.configured',
  'runtime.model_reconfigure.completed'
]

function lineMayMatter(line: string): boolean {
  return LINE_MARKERS.some((marker) => line.includes(marker))
}

// Why: `recorded_at` is microseconds since epoch.
function recordedAtIso(value: unknown): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return null
  }
  const date = new Date(Math.floor(value / 1000))
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function applyContextRecord(entry: JsonRecord, context: MuseUsageParseContext): void {
  const inner = record(record(entry.payload)?.record)
  if (!inner) {
    return
  }
  switch (entry.payload_type) {
    case 'runtime.session.metadata':
      // Why: the session's start directory, matching AI Vault's grouping.
      context.cwd = extractString(inner.workspace_root) ?? context.cwd
      context.currentModel ??= extractString(inner.model_id)
      break
    case 'runtime.session.route_facts':
      context.cwd ??= extractString(inner.cwd)
      break
    case 'run.model.configured':
      context.currentModel = extractString(inner.model_id) ?? context.currentModel
      break
    case 'runtime.model_reconfigure.completed':
      context.currentModel =
        extractString(record(inner.effective)?.model_id) ?? context.currentModel
      break
    default:
      break
  }
}

function toUsageEvent(
  entry: JsonRecord,
  context: MuseUsageParseContext
): MuseUsageParsedEvent | null {
  if (entry.payload_type !== 'runtime.session') {
    return null
  }
  const event = record(record(entry.payload)?.event)
  if (event?.kind !== 'model_completed') {
    return null
  }
  const usage = record(event.usage)
  const timestamp = recordedAtIso(entry.recorded_at)
  if (!usage || !timestamp) {
    return null
  }
  const inputTokens = ensureNumber(usage.input_tokens)
  const outputTokens = ensureNumber(usage.output_tokens)
  // Why: Muse reports cached/reasoning as subsets of input/output (OpenAI style);
  // clamp so a malformed record cannot push derived "new input" negative.
  const cachedInputTokens = Math.min(
    ensureNumber(usage.cached_tokens) || ensureNumber(usage.cache_read_tokens),
    inputTokens
  )
  const reasoningOutputTokens = Math.min(ensureNumber(usage.reasoning_tokens), outputTokens)
  const totalTokens = inputTokens + outputTokens
  if (totalTokens === 0) {
    return null
  }
  return {
    sessionId: context.sessionId,
    timestamp,
    // Why: keyed on content, not record id, so a copy re-stamped by a fork still dedupes.
    eventKey: [
      String(entry.recorded_at),
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens
    ].join(':'),
    model: extractString(event.model) ?? context.currentModel,
    cwd: context.cwd,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens
  }
}

/** Parses one session.jsonl line, which may be a `retained_frame` batching several records. */
export function parseMuseUsageLine(
  line: string,
  context: MuseUsageParseContext
): MuseUsageParsedEvent[] {
  if (!lineMayMatter(line)) {
    return []
  }
  let parsed: JsonRecord | undefined
  try {
    parsed = record(JSON.parse(line))
  } catch {
    return []
  }
  if (!parsed) {
    return []
  }
  const events: MuseUsageParsedEvent[] = []
  for (const entry of unwrapMuseLogRecords(parsed)) {
    applyContextRecord(entry, context)
    const event = toUsageEvent(entry, context)
    if (event) {
      events.push(event)
    }
  }
  return events
}
