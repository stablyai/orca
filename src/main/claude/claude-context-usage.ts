import {
  MAX_CONTEXT_CATEGORIES,
  MAX_CONTEXT_CATEGORY_NAME_CHARS,
  MAX_CONTEXT_MODEL_ID_CHARS,
  type AgentSessionContextReport,
  type AgentSessionContextUsageCategory,
  type AgentSessionTokenUsage
} from '../../shared/agent-session-context-usage'
import type { ClaudeStreamJsonConnection } from './claude-stream-json-connection'
import type { ClaudeJournalTranslator } from './claude-journal-translator-contract'

export const CLAUDE_CONTEXT_USAGE_TIMEOUT_MS = 5_000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function positiveCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** Synthetic responses report zero usage and cannot size the context. */
export function claudeTokenUsage(value: unknown): AgentSessionTokenUsage | null {
  if (!isRecord(value)) {
    return null
  }
  const usage = {
    inputTokens: positiveCount(value.input_tokens),
    cacheCreationInputTokens: positiveCount(value.cache_creation_input_tokens),
    cacheReadInputTokens: positiveCount(value.cache_read_input_tokens),
    outputTokens: positiveCount(value.output_tokens)
  }
  const total =
    usage.inputTokens +
    usage.cacheCreationInputTokens +
    usage.cacheReadInputTokens +
    usage.outputTokens
  return total > 0 ? usage : null
}

function modelId(value: unknown): string | null {
  const model = typeof value === 'string' ? value.trim() : ''
  return model.length > 0 && model.length <= MAX_CONTEXT_MODEL_ID_CHARS ? model : null
}

/** Window suffixes and casing do not change model identity. */
function contextBaseModelId(model: string): string {
  return model
    .replace(/\[[^\]]*\]$/u, '')
    .trim()
    .toLowerCase()
}

export function claudeContextWindowHint(model: string): number | null {
  // Bare names vary by provider and plan mode; only an explicit [1m] gives a reliable hint.
  if (!/\[1m\]$/iu.test(model.trim())) {
    return null
  }
  return 1_000_000
}

export type ClaudeMainThreadModel = { initModel: string | null; responseModel: string | null }

function currentInitModel({ initModel, responseModel }: ClaudeMainThreadModel): string | null {
  if (initModel === null || responseModel === null) {
    return initModel
  }
  // Under opusplan, init can name the resting model while Opus answers.
  if (contextBaseModelId(initModel) !== contextBaseModelId(responseModel)) {
    return null
  }
  return initModel
}

/** Per-model usage includes subagents and side calls; select the main thread's window. */
export function claudeContextWindowFromResult(
  message: Record<string, unknown>,
  main: ClaudeMainThreadModel = { initModel: null, responseModel: null }
): number | null {
  if (!isRecord(message.modelUsage)) {
    return null
  }
  const entries = Object.entries(message.modelUsage).flatMap(([key, usage]) => {
    const window = isRecord(usage) ? positiveCount(usage.contextWindow) : 0
    if (!isRecord(usage) || window === 0 || modelId(key) !== key) {
      return []
    }
    const canonicalModel = modelId(usage.canonicalModel)
    const bases = [key, ...(canonicalModel ? [canonicalModel] : [])].map(contextBaseModelId)
    return [{ key, window, bases }]
  })
  const initModel = currentInitModel(main)
  const names = [main.responseModel ?? initModel].flatMap((model) =>
    model ? [contextBaseModelId(model)] : []
  )
  // Fall back to the largest window when no named entry matches.
  let pool = entries
  const named = entries.filter((entry) => entry.bases.some((base) => names.includes(base)))
  if (named.length > 0) {
    pool = named
  }
  // Responses omit [1m]; prefer the exact init key to distinguish windows of the same model.
  const exact = entries.filter((entry) => entry.key === initModel)
  if (exact.length > 0) {
    pool = exact
  }
  return pool.reduce<number | null>(
    (best, entry) => (best === null || entry.window > best ? entry.window : best),
    null
  )
}

export function claudeContextResetKind(
  message: Record<string, unknown>
): 'compaction' | 'conversation' | null {
  if (message.type === 'system' && message.subtype === 'compact_boundary') {
    return 'compaction'
  }
  return message.type === 'conversation_reset' ? 'conversation' : null
}

function categoryName(value: unknown): string | null {
  const name = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : ''
  return name.length > 0 && name.length <= MAX_CONTEXT_CATEGORY_NAME_CHARS ? name : null
}

export function claudeContextReportFromControl(
  value: unknown,
  capturedAt: number
): AgentSessionContextReport | null {
  if (!isRecord(value)) {
    return null
  }
  const model = modelId(value.model)
  const usedTokens = count(value.totalTokens)
  const windowTokens = count(value.rawMaxTokens) || count(value.maxTokens)
  if (!model || usedTokens === null || !windowTokens) {
    return null
  }
  const categories: AgentSessionContextUsageCategory[] = []
  const rows = Array.isArray(value.categories) ? value.categories.filter(isRecord) : []
  for (const entry of rows.slice(0, MAX_CONTEXT_CATEGORIES)) {
    const name = categoryName(entry.name)
    const tokens = count(entry.tokens)
    if (name && tokens !== null) {
      categories.push({ name, tokens, ...(entry.isDeferred === true ? { deferred: true } : {}) })
    }
  }
  const autoCompactAtTokens =
    value.isAutoCompactEnabled === true ? count(value.autoCompactThreshold) : null
  return {
    model,
    usedTokens,
    windowTokens,
    percentage: count(value.percentage) ?? Math.round((usedTokens / windowTokens) * 100),
    ...(autoCompactAtTokens !== null ? { autoCompactAtTokens } : {}),
    categories,
    capturedAt
  }
}

export type ClaudeContextUsageCaptureOptions = {
  now?: () => number
  timeoutMs?: number
}

export type ClaudeContextUsageReader = Pick<ClaudeStreamJsonConnection, 'getContextUsage'>

export type ClaudeContextUsageTarget = Pick<
  ClaudeJournalTranslator,
  'subscribeContextUsageRequests' | 'recordContextReport' | 'contextActivity'
>

/** Newer requests discard old answers; conversation activity invalidates only usage, not the window. */
export function bindClaudeContextUsageCapture(
  connection: ClaudeContextUsageReader,
  translator: ClaudeContextUsageTarget | null,
  options: ClaudeContextUsageCaptureOptions
): (() => void) | undefined {
  if (!translator) {
    return undefined
  }
  let bound = true
  let requests = 0
  const unsubscribe = translator.subscribeContextUsageRequests((target) => {
    const request = ++requests
    const activity = translator.contextActivity
    void connection
      .getContextUsage({ timeoutMs: options.timeoutMs ?? CLAUDE_CONTEXT_USAGE_TIMEOUT_MS })
      .then(
        (answer) => {
          if (!bound || request !== requests) {
            return
          }
          const report = claudeContextReportFromControl(answer, options.now?.() ?? Date.now())
          if (!report) {
            return
          }
          if (activity !== translator.contextActivity) {
            translator.recordContextReport(target, report, 'window')
            return
          }
          translator.recordContextReport(target, report, 'report')
        },
        () => {}
      )
  })
  return () => {
    bound = false
    unsubscribe()
  }
}
