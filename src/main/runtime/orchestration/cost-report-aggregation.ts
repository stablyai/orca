import { splitWorktreeIdForFilesystem } from '../../../shared/worktree-id'
import type {
  OrchestrationReportElapsed,
  OrchestrationReportMetrics,
  OrchestrationReportProvider,
  OrchestrationReportProviderUsage,
  OrchestrationReportUsage,
  OrchestrationReportUsageSession
} from '../../../shared/orchestration-cost-report'
import type { OrchestrationReportDispatchRow } from './db'

export type ReportInterval = { start: number; end: number }

export const REPORT_PROVIDERS: OrchestrationReportProvider[] = ['codex', 'claude', 'opencode']

export function parseReportInterval(
  dispatch: OrchestrationReportDispatchRow,
  asOfMs: number
): ReportInterval | null {
  const start = Date.parse(dispatch.dispatched_at ?? dispatch.created_at)
  const end = dispatch.completed_at ? Date.parse(dispatch.completed_at) : asOfMs
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? { start, end } : null
}

export function aggregateElapsed(
  intervals: ReportInterval[],
  malformed: boolean
): OrchestrationReportElapsed {
  if (intervals.length === 0) {
    return { milliseconds: null, status: 'unavailable' }
  }
  const sorted = [...intervals].sort(
    (left, right) => left.start - right.start || left.end - right.end
  )
  let total = 0
  let current = sorted[0]
  for (const next of sorted.slice(1)) {
    if (next.start <= current.end) {
      current = { start: current.start, end: Math.max(current.end, next.end) }
    } else {
      total += current.end - current.start
      current = next
    }
  }
  total += current.end - current.start
  return { milliseconds: total, status: malformed ? 'partial' : 'available' }
}

function addNullable(values: (number | null)[]): number | null {
  const present = values.filter((value): value is number => value !== null)
  return present.length === 0 ? null : present.reduce((sum, value) => sum + value, 0)
}

function aggregateMetrics(sessions: OrchestrationReportUsageSession[]): OrchestrationReportMetrics {
  const costs = sessions.map((session) => session.metrics.estimatedCostUsd)
  const knownCosts = costs.filter((cost): cost is number => cost !== null)
  return {
    inputTokens: sessions.reduce((sum, session) => sum + session.metrics.inputTokens, 0),
    cachedInputTokens: addNullable(sessions.map((session) => session.metrics.cachedInputTokens)),
    outputTokens: sessions.reduce((sum, session) => sum + session.metrics.outputTokens, 0),
    reasoningOutputTokens: addNullable(
      sessions.map((session) => session.metrics.reasoningOutputTokens)
    ),
    cacheReadTokens: addNullable(sessions.map((session) => session.metrics.cacheReadTokens)),
    cacheWriteTokens: addNullable(sessions.map((session) => session.metrics.cacheWriteTokens)),
    totalTokens: sessions.reduce((sum, session) => sum + session.metrics.totalTokens, 0),
    estimatedCostUsd:
      knownCosts.length === 0 ? null : knownCosts.reduce((sum, cost) => sum + cost, 0),
    costStatus:
      knownCosts.length === 0
        ? 'unavailable'
        : sessions.every((session) => session.metrics.costStatus === 'known')
          ? 'known'
          : 'partial'
  }
}

export function aggregateUsage(
  sessions: OrchestrationReportUsageSession[]
): OrchestrationReportUsage {
  const providers: OrchestrationReportProviderUsage[] = []
  for (const provider of REPORT_PROVIDERS) {
    const matching = sessions.filter((session) => session.provider === provider)
    if (matching.length > 0) {
      providers.push({
        provider,
        sessionCount: matching.length,
        metrics: aggregateMetrics(matching)
      })
    }
  }
  return {
    attributionCertainty: providers.length > 0 ? 'inferred' : 'unavailable',
    providers
  }
}

export function recordedWorkdir(worktreeId: string | null): string | null {
  return worktreeId ? (splitWorktreeIdForFilesystem(worktreeId)?.worktreePath ?? null) : null
}

export function collectDescendants(
  taskId: string,
  childrenByTask: Map<string, string[]>,
  warnings: Set<string>
): Set<string> {
  const found = new Set<string>()
  const visiting = new Set([taskId])
  const stack = [...(childrenByTask.get(taskId) ?? [])]
  while (stack.length > 0) {
    const childId = stack.pop() as string
    if (visiting.has(childId)) {
      warnings.add(
        `Task parent cycle encountered at ${childId}; rolled-up values exclude the cycle.`
      )
      continue
    }
    if (!found.has(childId)) {
      found.add(childId)
      visiting.add(childId)
      stack.push(...(childrenByTask.get(childId) ?? []))
    }
  }
  return found
}
