import type {
  ClaudeUsageAttributedTurn,
  ClaudeUsageDailyAggregate,
  ClaudeUsagePersistedFile,
  ClaudeUsageSession
} from './types'
import type { ClaudeUsageParsedSourceTurn, ClaudeUsageScanFile } from './transcript-record-parser'
import {
  aggregateClaudeUsage,
  finalizeClaudeSessions,
  mergeClaudeDailyAggregates,
  mergeClaudeSessions
} from './usage-aggregation'
import { attributeClaudeUsageTurns, type ClaudeUsageWorktreeRef } from './worktree-attribution'
import {
  createClaudeUsageTokenCheckpoint,
  type ClaudeUsageTokenCorrection
} from './transcript-token-checkpoint'
import { buildClaudeUsageProjectionIntegrity } from './transcript-projection-integrity'

function dailyKey(day: string, model: string | null, projectKey: string): string {
  return [day, model ?? 'unknown', projectKey].join('::')
}

function applyTokenCorrection(
  correction: ClaudeUsageTokenCorrection,
  sessions: Map<string, ClaudeUsageSession>,
  daily: Map<string, ClaudeUsageDailyAggregate>
): void {
  const { previous, updated, projection } = correction
  if (!projection) {
    return
  }
  const session = sessions.get(projection.sessionId)
  const location = session?.locationBreakdown.find(
    (entry) => entry.locationKey === projection.projectKey
  )
  const aggregate = daily.get(dailyKey(projection.day, projection.model, projection.projectKey))
  if (!session || !location || !aggregate) {
    throw new Error('Claude usage checkpoint does not match its cached projection.')
  }
  const input = updated[0] - previous[0]
  const output = updated[1] - previous[1]
  const read = updated[2] - previous[2]
  const write = updated[3] - previous[3]
  const write1h = updated[4] - previous[4]
  session.totalInputTokens += input
  session.totalOutputTokens += output
  session.totalCacheReadTokens += read
  session.totalCacheWriteTokens += write
  session.totalCacheWrite1hTokens += write1h
  for (const target of [location, aggregate]) {
    target.inputTokens += input
    target.outputTokens += output
    target.cacheReadTokens += read
    target.cacheWriteTokens += write
    target.cacheWrite1hTokens += write1h
  }
  aggregate.zeroCacheReadTurnCount += Number(updated[2] === 0) - Number(previous[2] === 0)
}

function retainEncounterOrder(
  order: Map<string, string[]>,
  turns: ClaudeUsageAttributedTurn[]
): void {
  for (const turn of turns) {
    const locations = order.get(turn.sessionId)
    if (!locations) {
      order.set(turn.sessionId, [turn.projectKey])
    } else if (!locations.includes(turn.projectKey)) {
      locations.push(turn.projectKey)
    }
  }
}

function restoreEncounterOrder(
  sessions: Map<string, ClaudeUsageSession>,
  order: Map<string, string[]>
): Map<string, ClaudeUsageSession> {
  const ordered = new Map<string, ClaudeUsageSession>()
  for (const [sessionId, locations] of order) {
    const session = sessions.get(sessionId)
    if (!session) {
      continue
    }
    const locationIndex = new Map(locations.map((key, index) => [key, index]))
    session.locationBreakdown.sort(
      (a, b) => (locationIndex.get(a.locationKey) ?? 0) - (locationIndex.get(b.locationKey) ?? 0)
    )
    ordered.set(sessionId, session)
  }
  return ordered
}

export async function projectClaudeUsageScanFile(
  read: ClaudeUsageScanFile,
  worktreeLookup: Map<string, ClaudeUsageWorktreeRef>,
  claimKey: (key: string) => boolean,
  previous?: ClaudeUsagePersistedFile
): Promise<ClaudeUsagePersistedFile> {
  const retained = read.resumed ? previous : undefined
  const sessions = new Map<string, ClaudeUsageSession>()
  const daily = new Map<string, ClaudeUsageDailyAggregate>()
  mergeClaudeSessions(sessions, retained?.sessions ?? [])
  mergeClaudeDailyAggregates(daily, retained?.dailyAggregates ?? [])
  const owned = createClaudeUsageTokenCheckpoint(retained)
  const order = new Map(
    retained?.parseResumeState?.encounterOrder.map((entry) => [
      entry.sessionId,
      [...entry.projectKeys]
    ]) ?? []
  )
  let hasDeferredClaims = retained?.hasDeferredClaims ?? false
  const newTurns: ClaudeUsageParsedSourceTurn[] = []
  for (const turn of read.turns) {
    if (turn.dedupeKey && !claimKey(turn.dedupeKey)) {
      hasDeferredClaims = true
      continue
    }
    if (turn.dedupeKey && owned.find(turn.dedupeKey)) {
      const correction = owned.increase(turn.dedupeKey, turn)
      if (correction) {
        applyTokenCorrection(correction, sessions, daily)
      }
    } else {
      newTurns.push(turn)
    }
  }
  const attributed = await attributeClaudeUsageTurns(newTurns, worktreeLookup)
  let attributedIndex = 0
  for (const turn of newTurns) {
    const attribution = Number.isNaN(new Date(turn.timestamp).getTime())
      ? undefined
      : attributed[attributedIndex++]
    if (turn.dedupeKey) {
      owned.append(
        turn.dedupeKey,
        turn,
        attribution
          ? {
              sessionId: attribution.sessionId,
              day: attribution.day,
              model: attribution.model,
              projectKey: attribution.projectKey
            }
          : null
      )
    }
  }
  const appended = aggregateClaudeUsage(attributed)
  mergeClaudeSessions(sessions, appended.sessions)
  mergeClaudeDailyAggregates(daily, appended.dailyAggregates)
  retainEncounterOrder(order, attributed)
  const projected: ClaudeUsagePersistedFile = {
    ...read.processedFile,
    sessions: finalizeClaudeSessions(restoreEncounterOrder(sessions, order)),
    dailyAggregates: [...daily.values()].sort((a, b) =>
      a.day === b.day ? a.projectLabel.localeCompare(b.projectLabel) : a.day.localeCompare(b.day)
    ),
    ownedDedupeKeys: owned.ownedDedupeKeys,
    hasDeferredClaims,
    parseResumeState: read.checkpoint
      ? {
          ...read.checkpoint,
          lineCount: read.committedLineCount,
          ...owned.finish(),
          encounterOrder: [...order].map(([sessionId, projectKeys]) => ({ sessionId, projectKeys }))
        }
      : null
  }
  if (projected.parseResumeState) {
    projected.parseResumeState.projectionIntegrity = buildClaudeUsageProjectionIntegrity(projected)
  }
  return projected
}
