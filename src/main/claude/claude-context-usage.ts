// What the Claude CLI says about its context window, in the journal's shape,
// and the `get_context_usage` request that asks for the breakdown.

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

/** A report later than this describes a context the user has likely moved past. */
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

/** The API's accounting on an assistant frame; null for the all-zero usage the
 *  CLI stamps on rows it synthesizes, which say nothing about the window. */
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

/** `claude-opus-5[1m]` and `Claude-Opus-5` name the same model; the suffix picks a window, not a model. */
function contextBaseModelId(model: string): string {
  return model
    .replace(/\[[^\]]*\]$/u, '')
    .trim()
    .toLowerCase()
}

/** The window a configured model's name implies before one is measured; null when the name does not say. */
export function claudeContextWindowHint(model: string): number | null {
  // A bare name runs 1M first-party but 200k through a gateway, and `opusplan`/`haiku` switch model in plan mode.
  if (!/\[1m\]$/iu.test(model.trim())) {
    return null
  }
  return 1_000_000
}

/** What names the main loop's model: the turn's `system/init`, keyed exactly as
 *  `modelUsage` is, and the newest main-thread response, which drops `[1m]`. */
export type ClaudeMainThreadModel = { initModel: string | null; responseModel: string | null }

/** The turn's init model; an init older than the newest response names a model the session has left. */
function currentInitModel({ initModel, responseModel }: ClaudeMainThreadModel): string | null {
  if (initModel === null || responseModel === null) {
    return initModel
  }
  // Plan mode under `opusplan`: the init names the resting model while Opus answers.
  if (contextBaseModelId(initModel) !== contextBaseModelId(responseModel)) {
    return null
  }
  return initModel
}

/** The main thread's window from a result's per-model usage, which also counts
 *  subagents, side calls and models the session used before a switch. */
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
  // Nothing names the main thread's model: the largest window is usually the main loop's.
  let pool = entries
  const named = entries.filter((entry) => entry.bases.some((base) => names.includes(base)))
  if (named.length > 0) {
    pool = named
  }
  // Responses drop `[1m]`; only the init's key tells a 1M window from a 200k one of the same model.
  const exact = entries.filter((entry) => entry.key === initModel)
  if (exact.length > 0) {
    pool = exact
  }
  return pool.reduce<number | null>(
    (best, entry) => (best === null || entry.window > best ? entry.window : best),
    null
  )
}

/** A frame after which the CLI's context no longer holds what it held: a
 *  compaction, or a conversation reset. */
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

/** The `get_context_usage` answer; null when it is unusable. */
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

/**
 * Ask the CLI for its breakdown whenever the translator says one is due, and
 * record the answer on the turn the request named, or the newest when none was open. A
 * newer request drops the answer, since every model or window change asks
 * anew; conversation activity after the ask drops only its used count. A
 * failure (an older CLI, a closed child, a timeout) leaves the row as it was.
 */
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
          // Activity moves what is used, never the window the CLI runs; a model change asks anew.
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
