import {
  MAX_CONTEXT_CATEGORIES,
  MAX_CONTEXT_CATEGORY_NAME_CHARS,
  MAX_CONTEXT_MODEL_ID_CHARS,
  type AgentSessionContextUsage
} from '../../shared/agent-session/agent-session-context-usage'
import { traexRecord, traexText } from './traex-protocol'

const CATEGORY_NAMES: Readonly<Record<string, string>> = {
  systemPrompt: 'System prompt',
  toolDefinitions: 'Tool definitions',
  developerMessages: 'Developer messages',
  userMessages: 'User messages',
  assistantMessages: 'Assistant messages',
  toolResponses: 'Tool responses',
  otherMessages: 'Other messages',
  unattributed: 'Unattributed'
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

export function readTraexContextUsage(
  value: unknown,
  threadId: string
): AgentSessionContextUsage | null {
  const params = traexRecord(value)
  const snapshot = traexRecord(params.snapshot ?? traexRecord(params.context).contextUsage)
  const sampledAt = count(snapshot.sampledAt)
  const capturedAt = sampledAt === undefined ? Date.now() : sampledAt * 1000
  if (Object.keys(snapshot).length) {
    if (snapshot.threadId !== threadId) {
      return null
    }
    const usedTokens = count(snapshot.activeContextTokens)
    const windowTokens = count(snapshot.effectiveContextWindow)
    const model = traexText(snapshot.model)
    if (usedTokens === undefined || !windowTokens) {
      return { used: { kind: 'unknown', capturedAt } }
    }
    return {
      used: {
        kind: 'report',
        model: model && model.length <= MAX_CONTEXT_MODEL_ID_CHARS ? model : 'unknown',
        usedTokens,
        windowTokens,
        percentage: count(snapshot.usedPercentage) ?? Math.round((usedTokens / windowTokens) * 100),
        capturedAt,
        ...(count(snapshot.autoCompactTokenLimit) !== undefined
          ? { autoCompactAtTokens: count(snapshot.autoCompactTokenLimit) }
          : {}),
        categories: Array.isArray(snapshot.categories)
          ? snapshot.categories.slice(0, MAX_CONTEXT_CATEGORIES).flatMap((entry) => {
              const category = traexRecord(entry),
                tokens = count(category.tokens),
                kind = traexText(category.kind)
              return tokens !== undefined && kind && kind.length <= MAX_CONTEXT_CATEGORY_NAME_CHARS
                ? [{ name: CATEGORY_NAMES[kind] ?? kind, tokens }]
                : []
            })
          : []
      }
    }
  }
  const usage = traexRecord(params.tokenUsage),
    last = traexRecord(usage.last)
  const usedTokens = count(last.totalTokens),
    windowTokens = count(usage.modelContextWindow)
  if (usedTokens === undefined || usedTokens === 0) {
    return null
  }
  return !windowTokens
    ? { used: { kind: 'unknown', capturedAt } }
    : {
        used: {
          kind: 'report',
          model: 'unknown',
          usedTokens,
          windowTokens,
          percentage: Math.round((usedTokens / windowTokens) * 100),
          categories: [],
          capturedAt
        }
      }
}
