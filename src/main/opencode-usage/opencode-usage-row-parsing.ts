import { ensureNumber, extractString } from '../usage/usage-record-coercion'
import type { OpenCodeUsageRow } from './opencode-usage-row-queries'
import type { OpenCodeUsageParsedEvent } from './types'

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value !== 'string') {
    return null
  }
  try {
    const parsed = JSON.parse(value) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function extractModelLabel(data: Record<string, unknown>, sessionModel: unknown): string | null {
  const directModel = extractString(data.modelID) ?? extractString(data.modelId)
  const directProvider = extractString(data.providerID) ?? extractString(data.providerId)
  if (directModel) {
    return directProvider ? `${directProvider}/${directModel}` : directModel
  }

  const modelObject = parseJsonObject(data.model) ?? parseJsonObject(sessionModel)
  if (!modelObject) {
    return null
  }
  const modelID = extractString(modelObject.modelID) ?? extractString(modelObject.id)
  const providerID = extractString(modelObject.providerID)
  if (!modelID) {
    return null
  }
  return providerID ? `${providerID}/${modelID}` : modelID
}

function extractCwd(data: Record<string, unknown>, row: OpenCodeUsageRow): string | null {
  const pathData = parseJsonObject(data.path)
  return (
    extractString(pathData?.cwd) ??
    extractString(row.directory) ??
    extractString(row.worktree) ??
    null
  )
}

function normalizeMillis(value: unknown): number | null {
  const numeric = ensureNumber(value)
  if (numeric <= 0) {
    return null
  }
  return numeric < 10_000_000_000 ? numeric * 1000 : numeric
}

function extractTimestamp(data: Record<string, unknown>, row: OpenCodeUsageRow): string | null {
  const timeData = parseJsonObject(data.time)
  const millis =
    normalizeMillis(timeData?.completed) ??
    normalizeMillis(timeData?.created) ??
    normalizeMillis(row.time_updated) ??
    normalizeMillis(row.time_created)
  return millis ? new Date(millis).toISOString() : null
}

export function parseOpenCodeUsageRow(row: OpenCodeUsageRow): OpenCodeUsageParsedEvent | null {
  const data = parseJsonObject(row.data)
  if (!data) {
    return null
  }

  const tokens = parseJsonObject(data.tokens)
  if (!tokens) {
    return null
  }
  const cache = parseJsonObject(tokens.cache)
  const inputTokens = ensureNumber(tokens.input)
  const outputTokens = ensureNumber(tokens.output)
  const reasoningOutputTokens = ensureNumber(tokens.reasoning)
  const cachedInputTokens = Math.min(ensureNumber(cache?.read), inputTokens)
  const totalTokens =
    ensureNumber(tokens.total) > 0
      ? ensureNumber(tokens.total)
      : inputTokens + outputTokens + reasoningOutputTokens

  if (inputTokens + outputTokens + reasoningOutputTokens + cachedInputTokens + totalTokens <= 0) {
    return null
  }

  const timestamp = extractTimestamp(data, row)
  if (!timestamp) {
    return null
  }

  return {
    sessionId: row.session_id,
    timestamp,
    cwd: extractCwd(data, row),
    model: extractModelLabel(data, row.session_model),
    estimatedCostUsd: ensureNumber(data.cost) > 0 ? ensureNumber(data.cost) : null,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens
  }
}
