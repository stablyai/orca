import { basename } from 'node:path'
import { getLocalUsageDay } from '../usage/usage-calendar-range'
import { extractString } from '../usage/usage-record-coercion'
import type { UsageWorktreeResolver } from '../usage/usage-worktree-resolver'
import type { OmpUsageDailyAggregate, OmpUsageParseResumeState, OmpUsageSession } from './types'

/** Session and model state that later transcript lines depend on. */
export type OmpUsageParseContext = {
  sessionId: string
  sessionStartedAt: string | null
  cwd: string | null
  currentModel: string | null
  currentProvider: string | null
}

type OmpUsageTotals = {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  totalTokens: number
  costUsd: number
}

export type OmpUsageParseAccumulator = {
  firstUsageAt: string | null
  lastUsageAt: string | null
  lastUsageModel: string | null
  lastUsageProvider: string | null
  totals: OmpUsageTotals
  dailyByDay: Map<string, OmpUsageDailyAggregate>
}

export function createOmpUsageParseContext(
  filePath: string,
  resume: OmpUsageParseResumeState | null
): OmpUsageParseContext {
  return resume
    ? {
        sessionId: resume.sessionId,
        sessionStartedAt: resume.sessionStartedAt,
        cwd: resume.cwd,
        currentModel: resume.currentModel,
        currentProvider: resume.currentProvider
      }
    : {
        sessionId: basename(filePath, '.jsonl'),
        sessionStartedAt: null,
        cwd: null,
        currentModel: null,
        currentProvider: null
      }
}

export function createOmpUsageParseAccumulator(): OmpUsageParseAccumulator {
  return {
    firstUsageAt: null,
    lastUsageAt: null,
    lastUsageModel: null,
    lastUsageProvider: null,
    totals: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      costUsd: 0
    },
    dailyByDay: new Map()
  }
}

function positiveFinite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** Folds one transcript line into the session context; corrupt and non-usage records are ignored. */
export function applyOmpUsageLine(
  line: string,
  context: OmpUsageParseContext,
  accumulator: OmpUsageParseAccumulator
): void {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return
  }
  const record = parsed as Record<string, unknown>
  const type = extractString(record.type)

  if (type === 'session') {
    const sessionId = extractString(record.id)
    if (sessionId) {
      context.sessionId = sessionId
    }
    context.cwd = extractString(record.cwd) ?? context.cwd
    context.sessionStartedAt = extractString(record.timestamp) ?? context.sessionStartedAt
    return
  }

  if (type === 'model_change') {
    context.currentModel = extractString(record.model) ?? context.currentModel
    return
  }

  // Title, custom, thinking-level and other omp records carry no usage.
  if (type !== 'message') {
    return
  }
  if (
    record.message === null ||
    typeof record.message !== 'object' ||
    Array.isArray(record.message)
  ) {
    return
  }
  const message = record.message as Record<string, unknown>
  // Message-level model/provider overrides outrank the session's current selection.
  context.currentModel = extractString(message.model) ?? context.currentModel
  context.currentProvider = extractString(message.provider) ?? context.currentProvider
  if (message.usage === null || typeof message.usage !== 'object' || Array.isArray(message.usage)) {
    return
  }

  const usage = message.usage as Record<string, unknown>
  const inputTokens = positiveFinite(usage.input)
  const outputTokens = positiveFinite(usage.output)
  const cacheReadTokens = positiveFinite(usage.cacheRead)
  const cacheWriteTokens = positiveFinite(usage.cacheWrite)
  const reasoningTokens = positiveFinite(usage.reasoningTokens)
  if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens === 0) {
    return
  }

  const timestamp = extractString(record.timestamp)
  const day = timestamp ? getLocalUsageDay(timestamp) : null
  if (!timestamp || !day) {
    return
  }
  const cost = usage.cost
  const costUsd =
    cost !== null && typeof cost === 'object' && !Array.isArray(cost)
      ? positiveFinite((cost as Record<string, unknown>).total)
      : 0
  // omp's own totalTokens may exclude reasoning; rebuild it from the reported components.
  const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens

  const totals = accumulator.totals
  totals.inputTokens += inputTokens
  totals.outputTokens += outputTokens
  totals.cacheReadTokens += cacheReadTokens
  totals.cacheWriteTokens += cacheWriteTokens
  totals.reasoningTokens += reasoningTokens
  totals.totalTokens += totalTokens
  totals.costUsd += costUsd

  if (!accumulator.firstUsageAt || timestamp < accumulator.firstUsageAt) {
    accumulator.firstUsageAt = timestamp
  }
  // The last usage message of the session names its dominant model.
  if (!accumulator.lastUsageAt || timestamp >= accumulator.lastUsageAt) {
    accumulator.lastUsageAt = timestamp
    accumulator.lastUsageModel = context.currentModel ?? 'unknown'
    accumulator.lastUsageProvider = context.currentProvider ?? 'unknown'
  }

  let daily = accumulator.dailyByDay.get(day)
  if (!daily) {
    daily = {
      day,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      costUsd: 0
    }
    accumulator.dailyByDay.set(day, daily)
  }
  daily.inputTokens += inputTokens
  daily.outputTokens += outputTokens
  daily.cacheReadTokens += cacheReadTokens
  daily.cacheWriteTokens += cacheWriteTokens
  daily.reasoningTokens += reasoningTokens
  daily.totalTokens += totalTokens
  daily.costUsd += costUsd
}

/** Sessions with no usage-bearing message are omitted from the projection. */
export function finalizeOmpSessions(
  context: OmpUsageParseContext,
  accumulator: OmpUsageParseAccumulator,
  resolveWorktree: UsageWorktreeResolver
): OmpUsageSession[] {
  if (!accumulator.lastUsageAt) {
    return []
  }
  const worktree = context.cwd ? resolveWorktree(context.cwd) : null
  return [
    {
      sessionId: context.sessionId,
      startedAt: context.sessionStartedAt ?? accumulator.firstUsageAt ?? accumulator.lastUsageAt,
      endedAt: accumulator.lastUsageAt,
      cwd: context.cwd ?? '',
      model: accumulator.lastUsageModel ?? 'unknown',
      provider: accumulator.lastUsageProvider ?? 'unknown',
      ...(worktree ? { repoId: worktree.repoId, worktreeId: worktree.worktreeId } : {}),
      ...accumulator.totals
    }
  ]
}
