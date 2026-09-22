import { extractString } from '../usage/usage-record-coercion'
import {
  buildCodexUsageEventKey,
  normalizeRawUsage,
  resolveCodexUsageDelta,
  type CodexUsageRawUsage
} from './codex-usage-token-delta'
import type { CodexUsageParsedEvent } from './types'

type CodexUsageRawRecord = {
  timestamp?: string
  type?: string
  payload?: Record<string, unknown>
}

export type CodexUsageParseContext = {
  sessionId: string
  sessionCwd: string | null
  currentCwd: string | null
  currentModel: string | null
  previousTotals: CodexUsageRawUsage | null
  totalOnlyBaselinePending?: boolean
}

function extractModel(value: unknown): string | null {
  if (value == null || typeof value !== 'object') {
    return null
  }

  const record = value as Record<string, unknown>
  const direct = [extractString(record.model), extractString(record.model_name)].find(
    (candidate) => candidate !== null
  )
  if (direct) {
    return direct
  }

  if (record.info && typeof record.info === 'object') {
    const info = record.info as Record<string, unknown>
    const infoDirect = [extractString(info.model), extractString(info.model_name)].find(
      (candidate) => candidate !== null
    )
    if (infoDirect) {
      return infoDirect
    }
    if (info.metadata && typeof info.metadata === 'object') {
      const metadata = info.metadata as Record<string, unknown>
      const metadataModel = extractString(metadata.model)
      if (metadataModel) {
        return metadataModel
      }
    }
  }

  if (record.metadata && typeof record.metadata === 'object') {
    const metadata = record.metadata as Record<string, unknown>
    return extractString(metadata.model)
  }

  return null
}

export function parseCodexUsageRecord(
  line: string,
  context: CodexUsageParseContext
): CodexUsageParsedEvent | null {
  let parsed: CodexUsageRawRecord
  try {
    parsed = JSON.parse(line) as CodexUsageRawRecord
  } catch {
    return null
  }

  if (!parsed.type || !parsed.payload) {
    return null
  }

  if (parsed.type === 'session_meta') {
    context.sessionId = extractString(parsed.payload.id) ?? context.sessionId
    context.sessionCwd = extractString(parsed.payload.cwd)
    if (!context.currentCwd && context.sessionCwd) {
      context.currentCwd = context.sessionCwd
    }
    return null
  }

  if (parsed.type === 'turn_context') {
    context.currentCwd =
      extractString(parsed.payload.cwd) ?? context.currentCwd ?? context.sessionCwd
    context.currentModel = extractModel(parsed.payload) ?? context.currentModel
    return null
  }

  if (parsed.type !== 'event_msg' || parsed.payload.type !== 'token_count' || !parsed.timestamp) {
    return null
  }

  const info = parsed.payload.info
  if (info == null || typeof info !== 'object') {
    // Why: Codex emits token_count snapshots with null info for rate-limit
    // updates. Treating them as malformed usage would make active sessions look
    // flaky and create false scan errors for perfectly valid logs.
    return null
  }

  const record = info as Record<string, unknown>
  const totalUsage = normalizeRawUsage(record.total_token_usage)
  const lastUsage = normalizeRawUsage(record.last_token_usage)
  if (context.totalOnlyBaselinePending) {
    context.totalOnlyBaselinePending = false
    if (totalUsage && !lastUsage && !context.previousTotals) {
      context.previousTotals = totalUsage
      return null
    }
  }
  const resolvedUsage = resolveCodexUsageDelta(totalUsage, lastUsage, context.previousTotals)
  if (!resolvedUsage) {
    return null
  }
  if (resolvedUsage.kind === 'baseline') {
    context.previousTotals = resolvedUsage.nextTotals
    return null
  }

  let delta = {
    ...resolvedUsage.delta,
    cachedInputTokens: Math.min(
      resolvedUsage.delta.cachedInputTokens,
      resolvedUsage.delta.inputTokens
    )
  }

  if (
    delta.inputTokens === 0 &&
    delta.cachedInputTokens === 0 &&
    delta.outputTokens === 0 &&
    delta.reasoningOutputTokens === 0 &&
    delta.totalTokens === 0
  ) {
    return null
  }

  context.previousTotals = resolvedUsage.nextTotals

  const resolvedModel = extractModel(parsed.payload) ?? context.currentModel
  const hasInferredPricing = resolvedModel === null

  return {
    sessionId: context.sessionId,
    timestamp: parsed.timestamp,
    eventKey: buildCodexUsageEventKey(parsed.timestamp, totalUsage, lastUsage),
    cwd: context.currentCwd ?? context.sessionCwd,
    model: resolvedModel,
    hasInferredPricing,
    inputTokens: delta.inputTokens,
    cachedInputTokens: delta.cachedInputTokens,
    outputTokens: delta.outputTokens,
    reasoningOutputTokens: delta.reasoningOutputTokens,
    totalTokens: delta.totalTokens
  }
}
