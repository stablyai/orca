import { extractString } from '../usage/usage-record-coercion'
import {
  buildGeminiUsageEventKey,
  normalizeRawUsage,
  resolveGeminiUsageDelta,
  type GeminiUsageRawUsage
} from './gemini-usage-token-delta'
import { estimateCostUsd } from './gemini-usage-cost-estimate'
import type { GeminiUsageParsedEvent } from './types'

export type GeminiUsageParseContext = {
  sessionId: string
  sessionCwd: string | null
  currentCwd: string | null
  currentModel: string | null
  previousTotals: GeminiUsageRawUsage | null
  accumulatedPromptLength?: number
}

function extractModelFromText(text: string): string | null {
  const match = text.match(/`Model Selection` from .*? to ([^.\n`]+)/i)
  if (!match?.[1]) {
    return null
  }
  const raw = match[1].trim()
  if (/gemini.*3\.7.*flash/i.test(raw)) {
    return 'gemini-3.7-flash'
  }
  if (/gemini.*3.*pro/i.test(raw)) {
    return 'gemini-3.0-pro'
  }
  if (/gemini.*2\.5.*pro/i.test(raw)) {
    return 'gemini-2.5-pro'
  }
  if (/gemini.*2\.5.*flash/i.test(raw)) {
    return 'gemini-2.5-flash'
  }
  return raw.toLowerCase().replace(/\s+/g, '-')
}

export function extractModel(value: unknown): string | null {
  if (value == null || typeof value !== 'object') {
    return null
  }
  const rec = value as Record<string, unknown>
  const direct = [
    extractString(rec.model),
    extractString(rec.model_name),
    extractString(rec.modelId)
  ].find(Boolean)
  if (direct) {
    return direct
  }
  if (rec.info && typeof rec.info === 'object') {
    const info = rec.info as Record<string, unknown>
    const fromInfo = [extractString(info.model), extractString(info.model_name)].find(Boolean)
    if (fromInfo) {
      return fromInfo
    }
  }
  if (rec.metadata && typeof rec.metadata === 'object') {
    const meta = rec.metadata as Record<string, unknown>
    const fromMeta = [extractString(meta.model), extractString(meta.model_name)].find(Boolean)
    if (fromMeta) {
      return fromMeta
    }
  }
  if (typeof rec.content === 'string') {
    return extractModelFromText(rec.content)
  }
  return null
}

export function extractTimestamp(record: Record<string, unknown>): string | null {
  return (
    [
      extractString(record.timestamp),
      extractString(record.created_at),
      extractString(record.createdAt),
      extractString(record.time),
      extractString(record.startTime),
      extractString(record.lastUpdated)
    ].find(Boolean) ?? null
  )
}

export function extractCwd(record: Record<string, unknown>): string | null {
  const direct = [
    extractString(record.cwd),
    extractString(record.working_dir),
    extractString(record.workspace),
    extractString(record.workspaceDir),
    extractString(record.projectDir)
  ].find(Boolean)
  if (direct) {
    return direct
  }

  if (Array.isArray(record.tool_calls)) {
    for (const call of record.tool_calls) {
      if (
        typeof call === 'object' &&
        call !== null &&
        typeof (call as Record<string, unknown>).args === 'object'
      ) {
        const args = (call as Record<string, unknown>).args as Record<string, unknown>
        const candidate =
          extractString(args.Cwd) ??
          extractString(args.DirectoryPath) ??
          extractString(args.projectPath) ??
          extractString(args.AbsolutePath)
        if (candidate) {
          const clean = candidate.replace(/^["']|["']$/g, '')
          if (clean && !clean.includes('.gemini') && !clean.includes('AppData')) {
            return clean
          }
        }
      }
    }
  }
  return null
}

export function parseGeminiUsageRecord(
  line: string,
  context: GeminiUsageParseContext
): GeminiUsageParsedEvent | null {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
    return null
  }

  let parsed: Record<string, unknown>
  try {
    const raw = JSON.parse(trimmed) as unknown
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return null
    }
    parsed = raw as Record<string, unknown>
  } catch {
    return null
  }

  const sessionId = extractString(parsed.sessionId) ?? extractString(parsed.conversation_id)
  if (sessionId) {
    context.sessionId = sessionId
  }

  const cwd = extractCwd(parsed)
  if (cwd) {
    context.currentCwd = cwd
    context.sessionCwd ??= cwd
  }

  const model = extractModel(parsed)
  if (model) {
    context.currentModel = model
  }

  const timestamp = extractTimestamp(parsed)
  if (!timestamp) {
    return null
  }

  const source = extractString(parsed.source)
  const type = extractString(parsed.type)
  const isUserTurn =
    source === 'USER_EXPLICIT' ||
    source === 'USER' ||
    type === 'USER_INPUT' ||
    type === 'user' ||
    type === 'REQUEST'

  if (isUserTurn) {
    context.accumulatedPromptLength =
      (context.accumulatedPromptLength ?? 0) + (parsed.content ? String(parsed.content).length : 0)
    return null
  }

  const payload =
    typeof parsed.payload === 'object' && parsed.payload !== null
      ? (parsed.payload as Record<string, unknown>)
      : parsed

  let rawUsage = normalizeRawUsage(payload)
  const isModelTurn =
    source === 'MODEL' ||
    type === 'PLANNER_RESPONSE' ||
    type === 'gemini' ||
    type === 'model' ||
    type === 'assistant'

  let hasInferredPricing = false
  if (!rawUsage && isModelTurn) {
    hasInferredPricing = true
    const contentLen = parsed.content ? String(parsed.content).length : 0
    const toolCallsLen = parsed.tool_calls ? JSON.stringify(parsed.tool_calls).length : 0
    const thinkingLen = parsed.thinking ? String(parsed.thinking).length : 0
    const inputTokens = Math.max(10, Math.ceil(((context.accumulatedPromptLength ?? 0) + 200) / 4))
    const outputTokens = Math.max(5, Math.ceil((contentLen + toolCallsLen) / 4))
    const reasoningOutputTokens = thinkingLen > 0 ? Math.max(1, Math.ceil(thinkingLen / 4)) : 0
    rawUsage = {
      inputTokens,
      cachedInputTokens: 0,
      outputTokens,
      reasoningOutputTokens,
      totalTokens: inputTokens + outputTokens + reasoningOutputTokens
    }
    context.accumulatedPromptLength = 0
  }
  if (!rawUsage) {
    return null
  }

  const isCumulative =
    parsed.type === 'token_count' ||
    Boolean(
      parsed.total_token_usage ||
      (typeof parsed.payload === 'object' &&
        parsed.payload !== null &&
        (parsed.payload as Record<string, unknown>).total_token_usage)
    )

  const resolution = isCumulative
    ? resolveGeminiUsageDelta(rawUsage, null, context.previousTotals)
    : resolveGeminiUsageDelta(null, rawUsage, context.previousTotals)

  if (!resolution || resolution.kind === 'baseline') {
    if (resolution?.kind === 'baseline') {
      context.previousTotals = resolution.nextTotals
    }
    return null
  }

  context.previousTotals = resolution.nextTotals
  const explicitModel = extractModel(payload) ?? context.currentModel
  const activeModel = explicitModel ?? 'gemini-2.5-pro'
  if (!explicitModel) {
    hasInferredPricing = true
  }
  const activeCwd = extractCwd(payload) ?? context.currentCwd ?? context.sessionCwd
  const estimatedCostUsd = estimateCostUsd(
    activeModel,
    resolution.delta.inputTokens,
    resolution.delta.cachedInputTokens,
    resolution.delta.outputTokens,
    resolution.delta.reasoningOutputTokens
  )
  return {
    sessionId: context.sessionId || 'gemini-session',
    timestamp,
    eventKey: buildGeminiUsageEventKey(timestamp, resolution.delta, null),
    model: activeModel,
    cwd: activeCwd,
    hasInferredPricing,
    estimatedCostUsd,
    inputTokens: resolution.delta.inputTokens,
    cachedInputTokens: resolution.delta.cachedInputTokens,
    outputTokens: resolution.delta.outputTokens,
    reasoningOutputTokens: resolution.delta.reasoningOutputTokens,
    totalTokens: resolution.delta.totalTokens
  }
}
