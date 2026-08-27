import { extractString } from '../usage/usage-record-coercion'
import {
  buildGeminiUsageEventKey,
  normalizeRawUsage,
  resolveGeminiUsageDelta
} from './gemini-usage-token-delta'
import { estimateCostUsd } from './gemini-usage-cost-estimate'
import {
  extractCwd,
  extractModel,
  extractTimestamp,
  type GeminiUsageParseContext
} from './gemini-usage-record-parser'
import type { GeminiUsageParsedEvent } from './types'

export function parseGeminiJsonDocument(
  content: string,
  context: GeminiUsageParseContext
): GeminiUsageParsedEvent[] {
  let doc: Record<string, unknown>
  try {
    const parsed = JSON.parse(content) as unknown
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return []
    }
    doc = parsed as Record<string, unknown>
  } catch {
    return []
  }

  const sessionId =
    extractString(doc.sessionId) ?? extractString(doc.conversation_id) ?? context.sessionId
  if (sessionId) {
    context.sessionId = sessionId
  }
  const rootCwd = extractCwd(doc) ?? context.sessionCwd
  if (rootCwd) {
    context.sessionCwd = rootCwd
    context.currentCwd = rootCwd
  }

  const events: GeminiUsageParsedEvent[] = []
  const messages = Array.isArray(doc.messages) ? doc.messages : []

  for (const message of messages) {
    if (typeof message !== 'object' || message === null) {
      continue
    }
    const msgRecord = message as Record<string, unknown>
    const msgModel = extractModel(msgRecord) ?? context.currentModel
    if (msgModel) {
      context.currentModel = msgModel
    }
    const msgCwd = extractCwd(msgRecord) ?? context.currentCwd ?? rootCwd
    const timestamp = extractTimestamp(msgRecord) ?? extractTimestamp(doc)
    if (!timestamp) {
      continue
    }

    const isUser =
      msgRecord.type === 'user' ||
      msgRecord.type === 'USER_INPUT' ||
      msgRecord.type === 'REQUEST' ||
      msgRecord.source === 'USER_EXPLICIT' ||
      msgRecord.source === 'USER'
    if (isUser) {
      context.accumulatedPromptLength =
        (context.accumulatedPromptLength ?? 0) +
        (msgRecord.content ? String(msgRecord.content).length : 0)
      continue
    }

    const isModel =
      msgRecord.type === 'gemini' ||
      msgRecord.type === 'assistant' ||
      msgRecord.type === 'model' ||
      msgRecord.type === 'PLANNER_RESPONSE' ||
      msgRecord.source === 'MODEL'

    let rawUsage = normalizeRawUsage(msgRecord)
    let hasInferredPricing = false

    if (!rawUsage && isModel) {
      hasInferredPricing = true
      const contentLen = msgRecord.content ? String(msgRecord.content).length : 0
      const toolCallsLen = msgRecord.tool_calls ? JSON.stringify(msgRecord.tool_calls).length : 0
      const thinkingLen = msgRecord.thinking ? String(msgRecord.thinking).length : 0
      const inputTokens = Math.max(
        10,
        Math.ceil(((context.accumulatedPromptLength ?? 0) + 200) / 4)
      )
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
      continue
    }
    const resolution = resolveGeminiUsageDelta(null, rawUsage, context.previousTotals)
    if (!resolution || resolution.kind === 'baseline') {
      if (resolution?.kind === 'baseline') {
        context.previousTotals = resolution.nextTotals
      }
      continue
    }

    context.previousTotals = resolution.nextTotals
    const explicitModel = msgModel ?? context.currentModel
    const activeModel = explicitModel ?? 'gemini-2.5-pro'
    if (!explicitModel) {
      hasInferredPricing = true
    }
    const estimatedCostUsd = estimateCostUsd(
      activeModel,
      resolution.delta.inputTokens,
      resolution.delta.cachedInputTokens,
      resolution.delta.outputTokens,
      resolution.delta.reasoningOutputTokens
    )
    events.push({
      sessionId: context.sessionId || 'gemini-session',
      timestamp,
      eventKey: buildGeminiUsageEventKey(timestamp, resolution.delta, null),
      model: activeModel,
      cwd: msgCwd,
      hasInferredPricing,
      estimatedCostUsd,
      inputTokens: resolution.delta.inputTokens,
      cachedInputTokens: resolution.delta.cachedInputTokens,
      outputTokens: resolution.delta.outputTokens,
      reasoningOutputTokens: resolution.delta.reasoningOutputTokens,
      totalTokens: resolution.delta.totalTokens
    })
  }

  return events
}
