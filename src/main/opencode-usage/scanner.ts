import { yieldToEventLoop } from '../../shared/event-loop-yield'
import Database from '../sqlite/sync-database'
import { createUsageEventAggregation } from '../usage/usage-event-aggregation'
import {
  createUsageWorktreeResolver,
  type UsageWorktreeResolver
} from '../usage/usage-worktree-resolver'
import {
  compareOpenCodeClaimPriority,
  getProcessedDatabaseInfo,
  listOpenCodeDatabases,
  listOpenCodeDatabasesInDirectory
} from './opencode-database-discovery'
import { parseOpenCodeUsageRow } from './opencode-usage-row-parsing'
import { selectUsageRows } from './opencode-usage-row-queries'
import {
  attributeOpenCodeUsageEvent,
  type OpenCodeUsageWorktreeRef
} from './opencode-usage-worktree-attribution'
import type {
  OpenCodeUsageAttributedEvent,
  OpenCodeUsageDailyAggregate,
  OpenCodeUsagePersistedDatabase,
  OpenCodeUsageSession
} from './types'
import {
  createUsageAccountAttribution,
  createUsageAccountRootResolver,
  type UsageAccountRoot
} from '../usage/usage-account-attribution'

const YIELD_EVERY_DATABASES = 2

function addCost(left: number | null, right: number | null): number | null {
  if (left === null && right === null) {
    return null
  }
  return (left ?? 0) + (right ?? 0)
}

type OpenCodeUsageMetric = {
  estimatedCostUsd: number | null
  cacheWriteInputTokens?: number
}

const openCodeUsageAggregation = createUsageEventAggregation<
  OpenCodeUsageAttributedEvent,
  OpenCodeUsageMetric
>({
  metric: {
    empty: () => ({ estimatedCostUsd: null, cacheWriteInputTokens: 0 }),
    fromEvent: (event) => ({
      estimatedCostUsd: event.estimatedCostUsd,
      cacheWriteInputTokens: event.cacheWriteInputTokens ?? 0
    }),
    fold: (target, source) => {
      target.estimatedCostUsd = addCost(target.estimatedCostUsd, source.estimatedCostUsd)
      target.cacheWriteInputTokens =
        (target.cacheWriteInputTokens ?? 0) + (source.cacheWriteInputTokens ?? 0)
    }
  },
  cloneSessionForMerge: (session) => structuredClone(session)
})

const { finalizeSessions, mergeSessions, mergeDailyAggregates, sortDailyAggregates } =
  openCodeUsageAggregation

export async function parseOpenCodeUsageDatabase(
  dbPath: string,
  resolveWorktree: UsageWorktreeResolver,
  options: {
    claimSession?: (sessionId: string) => boolean
    accountIdForSession?: (sessionId: string) => string | null
  } = {}
): Promise<OpenCodeUsagePersistedDatabase> {
  const processedDatabase = await getProcessedDatabaseInfo(dbPath)
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    db.pragma('query_only = ON')
    const events: OpenCodeUsageAttributedEvent[] = []
    const claimedBySessionId = new Map<string, boolean>()
    const accountBySessionId = new Map<string, string | null>()
    let hasDeferredClaims = false
    for (const row of selectUsageRows(db)) {
      const parsed = parseOpenCodeUsageRow(row)
      if (!parsed) {
        continue
      }
      // Sibling backups duplicate sessions; count each from one owner.
      let owned = claimedBySessionId.get(parsed.sessionId)
      if (owned === undefined) {
        accountBySessionId.set(
          parsed.sessionId,
          options.accountIdForSession?.(parsed.sessionId) ?? null
        )
        owned = options.claimSession ? options.claimSession(parsed.sessionId) : true
        claimedBySessionId.set(parsed.sessionId, owned)
      }
      if (!owned) {
        hasDeferredClaims = true
        continue
      }
      const attributed = await attributeOpenCodeUsageEvent(parsed, resolveWorktree)
      if (attributed) {
        const accountId = accountBySessionId.get(parsed.sessionId)
        events.push(accountId ? { ...attributed, accountId } : attributed)
      }
    }
    const ownedSessionIds = [...claimedBySessionId.entries()]
      .filter(([, owned]) => owned)
      .map(([id]) => id)
    const ownedAccountIds = ownedSessionIds.map((id) => accountBySessionId.get(id) ?? null)
    return {
      ...processedDatabase,
      ...openCodeUsageAggregation.aggregate(events),
      ownedSessionIds,
      ...(ownedAccountIds.some((id) => id !== null) ? { ownedAccountIds } : {}),
      hasDeferredClaims
    }
  } finally {
    db.close()
  }
}

export async function scanOpenCodeUsageDatabases(
  worktrees: OpenCodeUsageWorktreeRef[],
  previousProcessedDatabases: OpenCodeUsagePersistedDatabase[],
  onFilesScanned?: (count: number) => void,
  accountRoots: UsageAccountRoot[] = [],
  reuseProjections = true,
  accountAttributionAvailable = true
): Promise<{
  processedDatabases: OpenCodeUsagePersistedDatabase[]
  sessions: OpenCodeUsageSession[]
  dailyAggregates: OpenCodeUsageDailyAggregate[]
}> {
  const dbPaths = [
    ...new Set([
      ...(await listOpenCodeDatabases()),
      ...(
        await Promise.all(accountRoots.map((root) => listOpenCodeDatabasesInDirectory(root.path)))
      ).flat()
    ])
  ].sort()
  const previousByPath = new Map(
    previousProcessedDatabases.map((database) => [database.path, database])
  )
  const accountAttribution = createUsageAccountAttribution(
    previousProcessedDatabases.map((database) => ({
      keys: database.ownedSessionIds ?? [],
      accountIds: database.ownedAccountIds
    }))
  )
  const resolveAccount = createUsageAccountRootResolver(
    accountAttributionAvailable ? accountRoots : []
  )
  const sourceAccounts = new Map(
    await Promise.all(dbPaths.map(async (path) => [path, await resolveAccount(path)] as const))
  )
  // Share per-cwd resolution memoization across databases.
  const resolveWorktree = await createUsageWorktreeResolver(worktrees)

  const currentPaths = new Set(dbPaths)
  // When an owner disappears, only caches with deferred claims can reclaim its sessions.
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
    const mustReclaimDeferred = lostOwnerPath && previous?.hasDeferredClaims !== false
    const canReuse =
      reuseProjections &&
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

  // A returning live database must reclaim sticky backup ownership; backups owning nothing
  // need no reparse when live data changes.
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

  // The live database claims before stale backups; reused caches retain persisted ownership.
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
    const processed = await parseOpenCodeUsageDatabase(dbPath, resolveWorktree, {
      accountIdForSession: (id) =>
        accountAttribution.observe(id, sourceAccounts.get(dbPath) ?? null),
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

    onFilesScanned?.(1)
    if ((index + 1) % YIELD_EVERY_DATABASES === 0) {
      await yieldToEventLoop()
    }
  }

  for (const dbPath of dbPaths) {
    const current = parsedByPath.get(dbPath) ?? reusedByPath.get(dbPath)
    if (
      current &&
      accountAttribution.needsReprojection({
        keys: current.ownedSessionIds,
        accountIds: current.ownedAccountIds
      })
    ) {
      const processed = await parseOpenCodeUsageDatabase(dbPath, resolveWorktree, {
        accountIdForSession: (id) =>
          accountAttribution.observe(id, sourceAccounts.get(dbPath) ?? null),
        claimSession: (id) => sessionOwnerById.get(id) === dbPath
      })
      reusedByPath.delete(dbPath)
      parsedByPath.set(dbPath, processed)
      onFilesScanned?.(1)
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
