import { readFile } from 'node:fs/promises'
import { asRecord, extractString } from '../ai-vault/session-scanner-values'
import {
  DEVIN_CACHE_CREATION_TOKEN_KEYS,
  DEVIN_CACHE_READ_TOKEN_KEYS,
  DEVIN_INPUT_TOKEN_KEYS,
  DEVIN_OUTPUT_TOKEN_KEYS,
  numberFromDevinMetadata
} from '../ai-vault/session-scanner-devin-parser'
import type { DevinUsageParsedEvent } from './types'

export function parseDevinUsageContent(content: string): DevinUsageParsedEvent[] {
  const record = asRecord(JSON.parse(content) as unknown)
  if (!record) {
    return []
  }
  const sessionId = extractString(record.session_id) ?? extractString(record.sessionId)
  if (!sessionId) {
    return []
  }
  const agent = asRecord(record.agent)
  const sessionModel =
    extractString(agent?.model_name) ??
    extractString(agent?.model) ??
    extractString(record.generation_model)
  const cwd = extractString(record.working_directory)
  const events: DevinUsageParsedEvent[] = []

  if (!Array.isArray(record.steps)) {
    return events
  }
  for (const step of record.steps) {
    const stepRecord = asRecord(step)
    const metadata = asRecord(stepRecord?.metadata)
    const metrics = asRecord(metadata?.metrics)
    const timestamp = extractString(metadata?.created_at)
    if (!timestamp || Number.isNaN(Date.parse(timestamp))) {
      continue
    }
    const inputTokens = numberFromDevinMetadata(metadata, metrics, DEVIN_INPUT_TOKEN_KEYS)
    const cachedInputTokens =
      numberFromDevinMetadata(metadata, metrics, DEVIN_CACHE_READ_TOKEN_KEYS) +
      numberFromDevinMetadata(metadata, metrics, DEVIN_CACHE_CREATION_TOKEN_KEYS)
    const outputTokens = numberFromDevinMetadata(metadata, metrics, DEVIN_OUTPUT_TOKEN_KEYS)
    const totalTokens = inputTokens + cachedInputTokens + outputTokens
    if (totalTokens === 0) {
      continue
    }
    events.push({
      sessionId,
      timestamp,
      model:
        extractString(metadata?.generation_model) ??
        extractString(metrics?.generation_model) ??
        sessionModel,
      cwd,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      reasoningOutputTokens: 0,
      totalTokens
    })
  }
  return events
}

export async function parseDevinUsageFile(path: string): Promise<DevinUsageParsedEvent[]> {
  return parseDevinUsageContent(await readFile(path, 'utf8'))
}
