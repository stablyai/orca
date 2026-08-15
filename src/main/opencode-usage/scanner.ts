/* eslint-disable max-lines -- Why: OpenCode usage analytics need to normalize multiple local DB schema generations, attribute worktrees, and build persisted projections in one auditable pipeline. */
import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, posix, win32 } from 'node:path'
import { yieldToEventLoop } from '../../shared/event-loop-yield'
import { wslGatedReaddir, wslGatedStat } from '../native-chat/wsl-transcript-fs-access'
import { WslTranscriptFsError } from '../native-chat/wsl-transcript-fs-gate'
import { areWorktreePathsEqual } from '../ipc/worktree-logic'
import { resolveOpenCodeDataDirectory } from '../opencode/opencode-data-directory'
import Database from '../sqlite/sync-database'
import { columnExists, tableExists } from './schema-helpers'
import { canonicalizeUsageWorktreePaths } from '../usage-worktree-canonicalizer'
import { createUsageEventAggregation } from '../usage/usage-event-aggregation'
import {
  looksLikeWindowsPath,
  normalizeComparablePath,
  normalizeFsPath
} from '../usage/usage-path-comparison'
import { ensureNumber, extractString } from '../usage/usage-record-coercion'
import type { UsageScanWorktreeRef } from '../usage/usage-provider-contract'
import type {
  OpenCodeUsageAttributedEvent,
  OpenCodeUsageDailyAggregate,
  OpenCodeUsageParsedEvent,
  OpenCodeUsagePersistedDatabase,
  OpenCodeUsageProcessedDatabase,
  OpenCodeUsageSession
} from './types'

export type OpenCodeUsageWorktreeRef = UsageScanWorktreeRef

type OpenCodeUsageRow = {
  id: string
  session_id: string
  time_created: number
  time_updated: number | null
  data: string
  directory: string | null
  title: string | null
  worktree: string | null
  session_model: string | null
}

type OpenCodeSessionUsageRow = {
  id: string
  session_id: string
  time_created: number
  time_updated: number | null
  directory: string | null
  title: string | null
  worktree: string | null
  session_model: string | null
  cost: number
  tokens_input: number
  tokens_output: number
  tokens_reasoning: number
  tokens_cache_read: number
}

const YIELD_EVERY_DATABASES = 2

type OpenCodeDatabaseOverride = {
  isConfigured: boolean
  path: string | null
}

function getOpenCodeDatabaseOverride(dataDirectory: string): OpenCodeDatabaseOverride {
  const raw = process.env.OPENCODE_DB?.trim()
  if (!raw) {
    return { isConfigured: false, path: null }
  }
  if (raw === ':memory:') {
    return { isConfigured: true, path: null }
  }
  return {
    isConfigured: true,
    path: isAbsolute(raw) ? raw : join(dataDirectory, raw)
  }
}

// Why gated: the AI Vault's primary OpenCode source delegates here from inside
// its discovery fan-out, so a UNC data dir or a UNC OPENCODE_DB on a stalled
// distro would otherwise hang the whole scan on a raw syscall (STA-4049).
export async function listOpenCodeDatabases(
  /** Lets a caller report the refusal; an empty list otherwise reads as
   *  "OpenCode not used" rather than "we could not look". */
  onRefusal?: (path: string, error: WslTranscriptFsError) => void
): Promise<string[]> {
  const dataDirectory = resolveOpenCodeDataDirectory()
  const databaseOverride = getOpenCodeDatabaseOverride(dataDirectory)
  if (databaseOverride.isConfigured) {
    if (!databaseOverride.path) {
      return []
    }
    try {
      return (await wslGatedStat(databaseOverride.path, 'scan')).isFile()
        ? [databaseOverride.path]
        : []
    } catch (error) {
      reportRefusal(databaseOverride.path, error, onRefusal)
      return []
    }
  }

  try {
    const entries = await wslGatedReaddir(dataDirectory, 'scan')
    return entries
      .filter((entry) => entry.isFile() && /^opencode(?:-[A-Za-z0-9_.-]+)?\.db$/.test(entry.name))
      .map((entry) => join(dataDirectory, entry.name))
      .sort()
  } catch (error) {
    reportRefusal(dataDirectory, error, onRefusal)
    return []
  }
}

function reportRefusal(
  path: string,
  error: unknown,
  onRefusal?: (path: string, error: WslTranscriptFsError) => void
): void {
  if (error instanceof WslTranscriptFsError) {
    onRefusal?.(path, error)
  }
}

function compareOpenCodeClaimPriority(left: string, right: string): number {
  // Why: the canonical opencode.db is the live database; it must claim
  // duplicated sessions ahead of stale sibling copies. Remaining ties use
  // path order so ownership is deterministic across rescans.
  const leftRank = basename(left).toLowerCase() === 'opencode.db' ? 0 : 1
  const rightRank = basename(right).toLowerCase() === 'opencode.db' ? 0 : 1
  if (leftRank !== rightRank) {
    return leftRank - rightRank
  }
  return left < right ? -1 : left > right ? 1 : 0
}

export async function getProcessedDatabaseInfo(
  dbPath: string
): Promise<OpenCodeUsageProcessedDatabase> {
  const dbStat = await stat(dbPath)
  return {
    path: dbPath,
    mtimeMs: dbStat.mtimeMs,
    size: dbStat.size
  }
}

function getProjectJoin(db: Database.Database): string {
  return tableExists(db, 'project') && columnExists(db, 'session', 'project_id')
    ? 'LEFT JOIN project p ON p.id = s.project_id'
    : 'LEFT JOIN (SELECT NULL AS id, NULL AS worktree) p ON 1 = 0'
}

function getSessionModelSelect(db: Database.Database): string {
  return columnExists(db, 'session', 'model') ? 's.model AS session_model' : 'NULL AS session_model'
}

function getAssistantSessionMessageCount(db: Database.Database): number {
  if (!tableExists(db, 'session_message')) {
    return 0
  }
  const assistantPredicate = columnExists(db, 'session_message', 'type')
    ? "type = 'assistant' AND json_extract(data, '$.tokens.input') IS NOT NULL"
    : "json_extract(data, '$.tokens.input') IS NOT NULL"
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM session_message WHERE ${assistantPredicate}`)
    .get() as { count?: number } | undefined
  return row?.count ?? 0
}

function canReadSessionUsageRows(db: Database.Database): boolean {
  if (!tableExists(db, 'session')) {
    return false
  }
  return ['cost', 'tokens_input', 'tokens_output', 'tokens_reasoning', 'tokens_cache_read'].every(
    (columnName) => columnExists(db, 'session', columnName)
  )
}

function getSessionUsageRowCount(db: Database.Database): number {
  if (!canReadSessionUsageRows(db)) {
    return 0
  }
  const row = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM session
       WHERE tokens_input + tokens_output + tokens_reasoning + tokens_cache_read > 0`
    )
    .get() as { count?: number } | undefined
  return row?.count ?? 0
}

function selectSessionUsageRows(db: Database.Database): OpenCodeUsageRow[] {
  const projectJoin = getProjectJoin(db)
  const sessionModelSelect = getSessionModelSelect(db)
  const rows = db
    .prepare(
      `SELECT s.id, s.id AS session_id, s.time_created, s.time_updated,
              s.directory, s.title, p.worktree, ${sessionModelSelect},
              s.cost, s.tokens_input, s.tokens_output, s.tokens_reasoning, s.tokens_cache_read
       FROM session s
       ${projectJoin}
       WHERE s.tokens_input + s.tokens_output + s.tokens_reasoning + s.tokens_cache_read > 0
       ORDER BY s.time_created, s.id`
    )
    .all() as OpenCodeSessionUsageRow[]

  return rows.map((row) => ({
    id: row.id,
    session_id: row.session_id,
    time_created: row.time_created,
    time_updated: row.time_updated,
    directory: row.directory,
    title: row.title,
    worktree: row.worktree,
    session_model: row.session_model,
    data: JSON.stringify({
      cost: row.cost,
      tokens: {
        input: row.tokens_input,
        output: row.tokens_output,
        reasoning: row.tokens_reasoning,
        total: row.tokens_input + row.tokens_output + row.tokens_reasoning,
        cache: {
          read: row.tokens_cache_read,
          write: 0
        }
      }
    })
  }))
}

function selectUsageRows(db: Database.Database): OpenCodeUsageRow[] {
  if (!tableExists(db, 'session')) {
    return []
  }

  // Why: newer OpenCode DBs maintain session-level token/cost totals. Reading
  // one aggregate row per session is faster than parsing every message blob.
  if (getSessionUsageRowCount(db) > 0) {
    return selectSessionUsageRows(db)
  }

  const projectJoin = getProjectJoin(db)
  const sessionModelSelect = getSessionModelSelect(db)

  if (getAssistantSessionMessageCount(db) > 0) {
    const assistantPredicate = columnExists(db, 'session_message', 'type')
      ? "sm.type = 'assistant'"
      : "json_extract(sm.data, '$.tokens.input') IS NOT NULL"
    return db
      .prepare(
        `SELECT sm.id, sm.session_id, sm.time_created, sm.time_updated, sm.data,
                s.directory, s.title, p.worktree, ${sessionModelSelect}
         FROM session_message sm
         JOIN session s ON s.id = sm.session_id
         ${projectJoin}
         WHERE ${assistantPredicate}
         ORDER BY sm.time_created, sm.id`
      )
      .all() as OpenCodeUsageRow[]
  }

  if (!tableExists(db, 'message')) {
    return []
  }

  return db
    .prepare(
      `SELECT m.id, m.session_id, m.time_created, m.time_updated, m.data,
              s.directory, s.title, p.worktree, ${sessionModelSelect}
       FROM message m
       JOIN session s ON s.id = m.session_id
       ${projectJoin}
       WHERE json_extract(m.data, '$.role') = 'assistant'
       ORDER BY m.time_created, m.id`
    )
    .all() as OpenCodeUsageRow[]
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value !== 'string') {
    return null
  }
  try {
    const parsed = JSON.parse(value) as unknown
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function extractModelLabel(data: Record<string, unknown>, sessionModel: unknown): string | null {
  const directModel = extractString(data.modelID) ?? extractString(data.modelId)
  const directProvider = extractString(data.providerID) ?? extractString(data.providerId)
  if (directModel) {
    return directProvider ? `${directProvider}/${directModel}` : directModel
  }

  const modelObject = parseJsonObject(data.model) ?? parseJsonObject(sessionModel)
  if (!modelObject) {
    return null
  }
  const modelID = extractString(modelObject.modelID) ?? extractString(modelObject.id)
  const providerID = extractString(modelObject.providerID)
  if (!modelID) {
    return null
  }
  return providerID ? `${providerID}/${modelID}` : modelID
}

function extractCwd(data: Record<string, unknown>, row: OpenCodeUsageRow): string | null {
  const pathData = parseJsonObject(data.path)
  return (
    extractString(pathData?.cwd) ??
    extractString(row.directory) ??
    extractString(row.worktree) ??
    null
  )
}

function normalizeMillis(value: unknown): number | null {
  const numeric = ensureNumber(value)
  if (numeric <= 0) {
    return null
  }
  return numeric < 10_000_000_000 ? numeric * 1000 : numeric
}

function extractTimestamp(data: Record<string, unknown>, row: OpenCodeUsageRow): string | null {
  const timeData = parseJsonObject(data.time)
  const millis =
    normalizeMillis(timeData?.completed) ??
    normalizeMillis(timeData?.created) ??
    normalizeMillis(row.time_updated) ??
    normalizeMillis(row.time_created)
  return millis ? new Date(millis).toISOString() : null
}

export function parseOpenCodeUsageRow(row: OpenCodeUsageRow): OpenCodeUsageParsedEvent | null {
  const data = parseJsonObject(row.data)
  if (!data) {
    return null
  }

  const tokens = parseJsonObject(data.tokens)
  if (!tokens) {
    return null
  }
  const cache = parseJsonObject(tokens.cache)
  const inputTokens = ensureNumber(tokens.input)
  const outputTokens = ensureNumber(tokens.output)
  const reasoningOutputTokens = ensureNumber(tokens.reasoning)
  const cachedInputTokens = Math.min(ensureNumber(cache?.read), inputTokens)
  const totalTokens =
    ensureNumber(tokens.total) > 0
      ? ensureNumber(tokens.total)
      : inputTokens + outputTokens + reasoningOutputTokens

  if (inputTokens + outputTokens + reasoningOutputTokens + cachedInputTokens + totalTokens <= 0) {
    return null
  }

  const timestamp = extractTimestamp(data, row)
  if (!timestamp) {
    return null
  }

  return {
    sessionId: row.session_id,
    timestamp,
    cwd: extractCwd(data, row),
    model: extractModelLabel(data, row.session_model),
    estimatedCostUsd: ensureNumber(data.cost) > 0 ? ensureNumber(data.cost) : null,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens
  }
}

function getDefaultProjectLabel(cwd: string | null): string {
  if (!cwd) {
    return 'Unknown location'
  }
  const parts = cwd.replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.length >= 2) {
    return parts.slice(-2).join('/')
  }
  return parts.at(-1) ?? cwd
}

function localDayFromTimestamp(timestamp: string): string | null {
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.getTime())) {
    return null
  }
  const year = parsed.getFullYear()
  const month = String(parsed.getMonth() + 1).padStart(2, '0')
  const day = String(parsed.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function isContainingPath(candidatePath: string, targetPath: string): boolean {
  const useWin32 = looksLikeWindowsPath(candidatePath) || looksLikeWindowsPath(targetPath)
  const relativePath = useWin32
    ? win32.relative(candidatePath, targetPath)
    : posix.relative(candidatePath, targetPath)
  if (!relativePath) {
    return true
  }
  const isAbsoluteRelative = useWin32
    ? win32.isAbsolute(relativePath)
    : posix.isAbsolute(relativePath)
  const parentPrefix = useWin32 ? `..${win32.sep}` : `..${posix.sep}`
  // Why: `..name` is a valid child path; only `..` and `../...` escape.
  return (
    !isAbsoluteRelative &&
    relativePath !== '..' &&
    !relativePath.startsWith(parentPrefix) &&
    relativePath !== '.'
  )
}

async function buildWorktreesWithCanonicalPaths(
  worktrees: OpenCodeUsageWorktreeRef[]
): Promise<(OpenCodeUsageWorktreeRef & { canonicalPath: string })[]> {
  return canonicalizeUsageWorktreePaths(worktrees, canonicalizePath)
}

async function canonicalizePath(pathValue: string): Promise<string> {
  try {
    return normalizeFsPath(await realpath(pathValue))
  } catch {
    return normalizeFsPath(pathValue)
  }
}

function findContainingWorktree(
  cwd: string,
  worktrees: (OpenCodeUsageWorktreeRef & { canonicalPath: string })[]
): OpenCodeUsageWorktreeRef | null {
  const normalizedCwd = normalizeFsPath(cwd)
  for (const worktree of worktrees) {
    if (areWorktreePathsEqual(worktree.canonicalPath, normalizedCwd)) {
      return worktree
    }
    if (isContainingPath(worktree.canonicalPath, normalizedCwd)) {
      return worktree
    }
  }
  return null
}

export async function attributeOpenCodeUsageEvent(
  event: OpenCodeUsageParsedEvent,
  worktrees: (OpenCodeUsageWorktreeRef & { canonicalPath: string })[]
): Promise<OpenCodeUsageAttributedEvent | null> {
  const day = localDayFromTimestamp(event.timestamp)
  if (!day) {
    return null
  }

  let repoId: string | null = null
  let worktreeId: string | null = null
  let projectKey = 'unscoped'
  let projectLabel = getDefaultProjectLabel(event.cwd)

  if (event.cwd) {
    const worktree = findContainingWorktree(event.cwd, worktrees)
    if (worktree) {
      repoId = worktree.repoId
      worktreeId = worktree.worktreeId
      projectKey = `worktree:${worktree.worktreeId}`
      projectLabel = worktree.displayName
    } else {
      projectKey = `cwd:${normalizeComparablePath(event.cwd)}`
    }
  }

  return {
    ...event,
    day,
    projectKey,
    projectLabel,
    repoId,
    worktreeId
  }
}

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
