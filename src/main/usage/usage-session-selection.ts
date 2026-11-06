import { groupUsageHistory } from '../../shared/usage-history-aggregation'
import type { UsageHistoryRow } from '../../shared/usage-history-types'
import type { CodexUsageDailyAggregate } from '../codex-usage/types'
import type { OpenCodeUsageDailyAggregate } from '../opencode-usage/types'
import type { MuseUsageDailyAggregate } from '../muse-usage/types'
import { projectEventUsageHistory } from './usage-history-projection'

type UsageSessionMetadata = {
  sessionId: string
  firstTimestamp: string
  lastTimestamp: string
  hasInferredPricing?: boolean
}

export function usageSessionDurationMinutes(
  session: UsageSessionMetadata | undefined
): number | null {
  if (!session) {
    return null
  }
  const duration = (Date.parse(session.lastTimestamp) - Date.parse(session.firstTimestamp)) / 60_000
  return Number.isFinite(duration) ? Math.max(0, Math.round(duration)) : null
}

export function selectEventUsageSessions(
  provider: 'codex' | 'opencode' | 'muse',
  daily: (CodexUsageDailyAggregate | OpenCodeUsageDailyAggregate | MuseUsageDailyAggregate)[],
  sessions: readonly UsageSessionMetadata[]
) {
  const selected = selectUsageSessionTotals(projectEventUsageHistory(provider, daily))
  if (!selected) {
    return null
  }
  const metadata = new Map(sessions.map((session) => [session.sessionId, session]))
  return selected.map((row) => ({
    sessionId: row.sessionId,
    lastActiveAt: metadata.get(row.sessionId)?.lastTimestamp ?? row.lastActiveDay,
    lastActiveDay: row.lastActiveDay,
    durationMinutes: usageSessionDurationMinutes(metadata.get(row.sessionId)),
    projectLabel: row.projectLabel,
    model: row.model,
    events: row.activityCount,
    inputTokens: row.inputTokens,
    cachedInputTokens: row.cacheReadTokens + row.cacheWriteTokens,
    outputTokens: row.outputTokens - (provider === 'opencode' ? row.reasoningOutputTokens : 0),
    reasoningOutputTokens: row.reasoningOutputTokens,
    totalTokens: row.totalTokens,
    hasInferredPricing: metadata.get(row.sessionId)?.hasInferredPricing ?? false
  }))
}

export function selectUsageSessionTotals(history: UsageHistoryRow[]) {
  if (history.length === 0 || history.some((row) => row.sessionId === null)) {
    return null
  }
  return groupUsageHistory(history, 'session', 'Unknown')
    .flatMap((group) => {
      const first = group.rows[0]
      if (!first?.sessionId) {
        return []
      }
      const projects = new Set(group.rows.map((row) => row.projectKey))
      const models = new Set(group.rows.map((row) => row.model))
      return [
        {
          sessionId: first.sessionId,
          lastActiveDay: group.rows.reduce(
            (day, row) => (row.day > day ? row.day : day),
            first.day
          ),
          projectLabel: projects.size > 1 ? 'Multiple locations' : first.projectLabel,
          model: models.size > 1 ? 'Mixed models' : first.model,
          activityCount: group.rows.reduce((sum, row) => sum + row.activityCount, 0),
          inputTokens: group.newInputTokens + group.cacheReadTokens + group.cacheWriteTokens,
          newInputTokens: group.newInputTokens,
          outputTokens: group.outputTokens,
          cacheReadTokens: group.cacheReadTokens,
          cacheWriteTokens: group.cacheWriteTokens,
          reasoningOutputTokens: group.rows.reduce((sum, row) => sum + row.reasoningTokens, 0),
          totalTokens: group.totalTokens
        }
      ]
    })
    .sort((a, b) => b.lastActiveDay.localeCompare(a.lastActiveDay))
}

export function countUsageDailySessions(
  daily: readonly { sessionId?: string }[],
  legacyCount: number
): number {
  return daily.length === 0 || daily.some((row) => row.sessionId === undefined)
    ? legacyCount
    : new Set(daily.map((row) => row.sessionId)).size
}

export function applyUsageBreakdownSessionCounts(
  breakdown: Iterable<{ key: string; sessions: number }>,
  daily: readonly { sessionId?: string; model: string | null; projectKey: string }[],
  kind: 'model' | 'project'
): void {
  if (daily.some((row) => row.sessionId === undefined)) {
    return
  }
  const sessionsByKey = new Map<string, Set<string>>()
  for (const row of daily) {
    if (row.sessionId) {
      const key = kind === 'model' ? (row.model ?? 'unknown') : row.projectKey
      const sessions = sessionsByKey.get(key) ?? new Set<string>()
      sessions.add(row.sessionId)
      sessionsByKey.set(key, sessions)
    }
  }
  for (const row of breakdown) {
    row.sessions = sessionsByKey.get(row.key)?.size ?? 0
  }
}
