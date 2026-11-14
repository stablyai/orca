import { record, type JsonRecord } from '../../shared/codex-rollout-jsonl-cursor'
import { extractString } from '../../shared/trimmed-string'
import { ensureNumber } from '../usage/source-input/usage-record-coercion'
import type { MistralVibeUsageParsedEvent } from './types'

/**
 * Vibe catalogs every session in `.session-index.json` with cumulative token usage, the model it ran,
 * and its working directory. Journals carry per-turn usage but no timestamps, so the catalog is the
 * only source that can attribute usage to a day.
 */
export function parseVibeSessionIndex(text: string): MistralVibeUsageParsedEvent[] {
  let parsed: JsonRecord | undefined
  try {
    parsed = record(JSON.parse(text))
  } catch {
    return []
  }
  const entries = parsed?.entries
  if (!Array.isArray(entries)) {
    return []
  }
  const events: MistralVibeUsageParsedEvent[] = []
  for (const raw of entries) {
    const entry = record(raw)
    const session = record(entry?.session)
    const sessionId = extractString(session?.id) ?? extractString(entry?.session_id)
    const updatedAt = ensureNumber(session?.updatedAt)
    if (!sessionId || updatedAt <= 0) {
      continue
    }
    const usage = record(session?.tokenUsage)
    const inputTokens = ensureNumber(usage?.inputTokens)
    const outputTokens = ensureNumber(usage?.outputTokens)
    const totalTokens = inputTokens + outputTokens
    if (totalTokens === 0) {
      continue
    }
    const metadata = record(entry?.metadata)
    events.push({
      sessionId,
      timestamp: new Date(updatedAt).toISOString(),
      eventKey: sessionId,
      model: extractString(metadata?.active_model),
      cwd: extractString(metadata?.cwd),
      inputTokens,
      // Cached input is a subset; clamp malformed records to avoid negative derived counts.
      cachedInputTokens: Math.min(ensureNumber(usage?.cachedInputTokens), inputTokens),
      outputTokens,
      // The catalog reports no reasoning split; journals carry it but no timestamps.
      reasoningOutputTokens: 0,
      totalTokens
    })
  }
  return events
}
