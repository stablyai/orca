import { yieldToEventLoop } from '../../shared/event-loop-yield'
import Database from '../sqlite/sync-database'
import { createUsageEventAggregation } from '../usage/usage-event-aggregation'
import {
  compareOpenCodeClaimPriority,
  getProcessedDatabaseInfo,
  listOpenCodeDatabases
} from './opencode-database-discovery'
import { parseOpenCodeUsageRow } from './opencode-usage-row-parsing'
import { selectUsageRows } from './opencode-usage-row-queries'
import {
  attributeOpenCodeUsageEvent,
  buildWorktreesWithCanonicalPaths,
  type OpenCodeUsageWorktreeRef
} from './opencode-usage-worktree-attribution'
import type {
  OpenCodeUsageAttributedEvent,
  OpenCodeUsageDailyAggregate,
  OpenCodeUsagePersistedDatabase,
  OpenCodeUsageSession
} from './types'

const YIELD_EVERY_DATABASES = 2

function addCost(left: number | null, right: number | null): number | null {
  if (left === null && right === null) {
    return null
  }
  return (left ?? 0) + (right ?? 0)
}

type OpenCodeUsageMetric = { estimatedCostUsd: number | null }

const openCodeUsageAggregation = createUsageEventAggregation<
  OpenCodeUsageAttributedEvent,
  OpenCodeUsageMetric
>({
  metric: {
    empty: () => ({ estimatedCostUsd: null }),
    fromEvent: (event) => ({ estimatedCostUsd: event.estimatedCostUsd }),
    fold: (target, source) => {
      target.estimatedCostUsd = addCost(target.estimatedCostUsd, source.estimatedCostUsd)
    }
  },
  cloneSessionForMerge: (session) => structuredClone(session)
})

const { finalizeSessions, mergeSessions, mergeDailyAggregates, sortDailyAggregates } =
  openCodeUsageAggregation

export async function parseOpenCodeUsageDatabase(
  dbPath: string,
  worktrees: (OpenCodeUsageWorktreeRef & { canonicalPath: string })[],
  options: { claimSession?: (sessionId: string) => boolean } = {}
): Promise<OpenCodeUsagePersistedDatabase> {
  const processedDatabase = await getProcessedDatabaseInfo(dbPath)
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    db.pragma('query_only = ON')
    const events: OpenCodeUsageAttributedEvent[] = []
    const claimedBySessionId = new Map<string, boolean>()
    let hasDeferredClaims = false
    for (const row of selectUsageRows(db)) {
      const parsed = parseOpenCodeUsageRow(row)
      if (!parsed) {
        continue
      }
      // Why: a stale sibling copy of opencode.db carries the same sessions, so
      // each session must be counted from exactly one database (#8006).
      let owned = claimedBySessionId.get(parsed.sessionId)
      if (owned === undefined) {
        owned = options.claimSession ? options.claimSession(parsed.sessionId) : true
        claimedBySessionId.set(parsed.sessionId, owned)
      }
      if (!owned) {
        hasDeferredClaims = true
        continue
      }
      const attributed = await attributeOpenCodeUsageEvent(parsed, worktrees)
      if (attributed) {
        events.push(attributed)
      }
    }
    return {
      ...processedDatabase,
      ...openCodeUsageAggregation.aggregate(events),
      ownedSessionIds: [...claimedBySessionId.entries()]
        .filter(([, owned]) => owned)
        .map(([sessionId]) => sessionId),
      hasDeferredClaims
    }
  } finally {
    db.close()
  }
}

export async function scanOpenCodeUsageDatabases(
  worktrees: OpenCodeUsageWorktreeRef[],
  previousProcessedDatabases: OpenCodeUsagePersistedDatabase[]
): Promise<{
  processedDatabases: OpenCodeUsagePersistedDatabase[]
  sessions: OpenCodeUsageSession[]
  dailyAggregates: OpenCodeUsageDailyAggregate[]
}> {
  const dbPaths = await listOpenCodeDatabases()
  const previousByPath = new Map(
    previousProcessedDatabases.map((database) => [database.path, database])
  )
  const worktreesWithCanonicalPaths = await buildWorktreesWithCanonicalPaths(worktrees)

  const currentPaths = new Set(dbPaths)
  // Why: when a database that owned sessions is deleted, remaining siblings
  // still contain those sessions but their caches record them as unowned.
  // Only databases that previously deferred claims can reclaim.
  const lostOwnerPath = previousProcessedDatabases.some(
    (database) =>
      !currentPaths.has(database.path) &&
      Array.isArray(database.ownedSessionIds) &&
      database.ownedSessionIds.length > 0
  )

  const reusedByPath = new Map<string, OpenCodeUsagePersistedDatabase>()
  const pathsToParse: string[] = []
  for (const dbPath of dbPaths) {
    const databaseInfo = await getProcessedDatabaseInfo(dbPath)
    const previous = previousByPath.get(dbPath)
    // When an owner disappears, only deferred-claim databases need reparse.
    const mustReclaimDeferred = lostOwnerPath && previous?.hasDeferredClaims !== false
    const canReuse =
      !mustReclaimDeferred &&
      previous &&
      previous.mtimeMs === databaseInfo.mtimeMs &&
      previous.size === databaseInfo.size &&
      Array.isArray(previous.ownedSessionIds) &&
      typeof previous.hasDeferredClaims === 'boolean'
    if (canReuse) {
      reusedByPath.set(dbPath, previous)
    } else {
      pathsToParse.push(dbPath)
    }
  }

  // Why: a sticky backup claim from a scan where opencode.db was missing would
  // otherwise freeze a still-growing session at the backup snapshot when the
  // live db reappears. Reparse a lower-priority sibling only when it still owns
  // sessions a higher-priority path could reclaim; a sibling that owns nothing
  // (the common case once the live db has claimed every shared session) has no
  // claim to give back, so reparsing it every time the live db changes is pure
  // work.
  const demotedReusePaths: string[] = []
  for (const [dbPath, reused] of reusedByPath) {
    if ((reused.ownedSessionIds?.length ?? 0) === 0) {
      continue
    }
    const higherPriorityParsing = pathsToParse.some(
      (candidate) => compareOpenCodeClaimPriority(candidate, dbPath) < 0
    )
    if (higherPriorityParsing) {
      demotedReusePaths.push(dbPath)
    }
  }
  for (const dbPath of demotedReusePaths) {
    reusedByPath.delete(dbPath)
    pathsToParse.push(dbPath)
  }

  // Why: `opencode-*.db` siblings are typically stale copies of `opencode.db`
  // (backups), so mergeSessions would double every duplicated session (#8006).
  // Each session is counted from exactly one database. The canonical live db
  // claims first so a stale backup cannot freeze a still-growing session at
  // its snapshot totals; cached databases keep the claims they persisted.
  const sessionOwnerById = new Map<string, string>()
  for (const dbPath of [...reusedByPath.keys()].sort(compareOpenCodeClaimPriority)) {
    const previous = reusedByPath.get(dbPath)
    for (const sessionId of previous?.ownedSessionIds ?? []) {
      if (!sessionOwnerById.has(sessionId)) {
        sessionOwnerById.set(sessionId, dbPath)
      }
    }
  }

  const parsedByPath = new Map<string, OpenCodeUsagePersistedDatabase>()
  const orderedPathsToParse = [...pathsToParse].sort(compareOpenCodeClaimPriority)
  for (const [index, dbPath] of orderedPathsToParse.entries()) {
    const processed = await parseOpenCodeUsageDatabase(dbPath, worktreesWithCanonicalPaths, {
      claimSession: (sessionId) => {
        const owner = sessionOwnerById.get(sessionId)
        if (owner !== undefined && owner !== dbPath) {
          return false
        }
        sessionOwnerById.set(sessionId, dbPath)
        return true
      }
    })
    parsedByPath.set(dbPath, processed)

    if ((index + 1) % YIELD_EVERY_DATABASES === 0) {
      await yieldToEventLoop()
    }
  }

  const processedDatabases: OpenCodeUsagePersistedDatabase[] = []
  const sessionsById = new Map<string, OpenCodeUsageSession>()
  const dailyByKey = new Map<string, OpenCodeUsageDailyAggregate>()
  for (const dbPath of dbPaths) {
    const processed = reusedByPath.get(dbPath) ?? parsedByPath.get(dbPath)
    if (!processed) {
      continue
    }
    processedDatabases.push(processed)
    mergeSessions(sessionsById, processed.sessions)
    mergeDailyAggregates(dailyByKey, processed.dailyAggregates)
  }

  return {
    processedDatabases,
    sessions: finalizeSessions(sessionsById),
    dailyAggregates: sortDailyAggregates(dailyByKey)
  }
}
