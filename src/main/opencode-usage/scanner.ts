/* eslint-disable max-lines -- Why: OpenCode usage analytics need to normalize multiple local DB schema generations, attribute worktrees, and build persisted projections in one auditable pipeline. */
import Database from 'better-sqlite3'
import { existsSync } from 'fs'
import { readdir, realpath, stat } from 'fs/promises'
import { homedir } from 'os'
import { isAbsolute, join, posix, win32 } from 'path'
import type { Repo } from '../../shared/types'
import { areWorktreePathsEqual } from '../ipc/worktree-logic'
import type {
  OpenCodeUsageAttributedEvent,
  OpenCodeUsageDailyAggregate,
  OpenCodeUsageLocationBreakdown,
  OpenCodeUsageLocationModelBreakdown,
  OpenCodeUsageModelBreakdown,
  OpenCodeUsageParsedEvent,
  OpenCodeUsagePersistedDatabase,
  OpenCodeUsageProcessedDatabase,
  OpenCodeUsageSession
} from './types'

export type OpenCodeUsageWorktreeRef = {
  repoId: string
  worktreeId: string
  path: string
  displayName: string
}

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

function ensureNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function normalizeComparablePath(pathValue: string, platform = process.platform): string {
  const normalized = pathValue.replace(/\\/g, '/')
  return platform === 'win32' || looksLikeWindowsPath(pathValue)
    ? normalized.toLowerCase()
    : normalized
}

function normalizeFsPath(pathValue: string, platform = process.platform): string {
  if (platform === 'win32' || looksLikeWindowsPath(pathValue)) {
    return win32.normalize(win32.resolve(pathValue))
  }
  return posix.normalize(posix.resolve(pathValue))
}

function looksLikeWindowsPath(pathValue: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(pathValue) || pathValue.startsWith('\\\\')
}

function getXdgDataHome(): string {
  if (process.env.XDG_DATA_HOME?.trim()) {
    return process.env.XDG_DATA_HOME.trim()
  }
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA || process.env.APPDATA || join(homedir(), 'AppData', 'Local')
  }
  return join(homedir(), '.local', 'share')
}

function getOpenCodeDataDirectory(): string {
  return join(getXdgDataHome(), 'opencode')
}

function getOpenCodeDatabasePathFromEnv(): string | null {
  const raw = process.env.OPENCODE_DB?.trim()
  if (!raw) {
    return null
  }
  if (raw === ':memory:') {
    return null
  }
  return isAbsolute(raw) ? raw : join(getOpenCodeDataDirectory(), raw)
}

export async function listOpenCodeDatabases(): Promise<string[]> {
  const envPath = getOpenCodeDatabasePathFromEnv()
  if (envPath) {
    return existsSync(envPath) ? [envPath] : []
  }

  try {
    const entries = await readdir(getOpenCodeDataDirectory(), { withFileTypes: true })
    return entries
      .filter((entry) => entry.isFile() && /^opencode(?:-[A-Za-z0-9_.-]+)?\.db$/.test(entry.name))
      .map((entry) => join(getOpenCodeDataDirectory(), entry.name))
      .sort()
  } catch {
    return []
  }
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

async function yieldToEventLoop(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(tableName) as { found?: number } | undefined
  return row?.found === 1
}

function columnExists(db: Database.Database, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as { name?: string }[]
  return rows.some((row) => row.name === columnName)
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

function extractString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
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
  return !isAbsoluteRelative && !relativePath.startsWith('..') && relativePath !== '.'
}

async function buildWorktreesWithCanonicalPaths(
  worktrees: OpenCodeUsageWorktreeRef[]
): Promise<(OpenCodeUsageWorktreeRef & { canonicalPath: string })[]> {
  const canonicalized = await Promise.all(
    worktrees.map(async (worktree) => ({
      ...worktree,
      canonicalPath: await canonicalizePath(worktree.path)
    }))
  )
  return canonicalized.sort((left, right) => right.canonicalPath.length - left.canonicalPath.length)
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

function createEmptySession(event: OpenCodeUsageAttributedEvent): OpenCodeUsageSession {
  return {
    sessionId: event.sessionId,
    firstTimestamp: event.timestamp,
    lastTimestamp: event.timestamp,
    primaryModel: event.model,
    hasMixedModels: false,
    primaryProjectLabel: event.projectLabel,
    hasMixedLocations: false,
    primaryWorktreeId: event.worktreeId,
    primaryRepoId: event.repoId,
    eventCount: 0,
    totalInputTokens: 0,
    totalCachedInputTokens: 0,
    totalOutputTokens: 0,
    totalReasoningOutputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: null,
    locationBreakdown: [],
    modelBreakdown: [],
    locationModelBreakdown: []
  }
}

function createEmptyDailyAggregate(
  event: OpenCodeUsageAttributedEvent
): OpenCodeUsageDailyAggregate {
  return {
    day: event.day,
    model: event.model,
    projectKey: event.projectKey,
    projectLabel: event.projectLabel,
    repoId: event.repoId,
    worktreeId: event.worktreeId,
    eventCount: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    estimatedCostUsd: null
  }
}

function mergeLocationBreakdown(
  target: OpenCodeUsageLocationBreakdown[],
  event: OpenCodeUsageAttributedEvent
): void {
  const existing = target.find((entry) => entry.locationKey === event.projectKey) ?? null
  if (existing) {
    existing.eventCount++
    existing.inputTokens += event.inputTokens
    existing.cachedInputTokens += event.cachedInputTokens
    existing.outputTokens += event.outputTokens
    existing.reasoningOutputTokens += event.reasoningOutputTokens
    existing.totalTokens += event.totalTokens
    existing.estimatedCostUsd = addCost(existing.estimatedCostUsd, event.estimatedCostUsd)
    return
  }

  target.push({
    locationKey: event.projectKey,
    projectLabel: event.projectLabel,
    repoId: event.repoId,
    worktreeId: event.worktreeId,
    eventCount: 1,
    inputTokens: event.inputTokens,
    cachedInputTokens: event.cachedInputTokens,
    outputTokens: event.outputTokens,
    reasoningOutputTokens: event.reasoningOutputTokens,
    totalTokens: event.totalTokens,
    estimatedCostUsd: event.estimatedCostUsd
  })
}

function mergeModelBreakdown(
  target: OpenCodeUsageModelBreakdown[],
  event: OpenCodeUsageAttributedEvent
): void {
  const key = event.model ?? 'unknown'
  const existing = target.find((entry) => entry.modelKey === key) ?? null
  if (existing) {
    existing.eventCount++
    existing.inputTokens += event.inputTokens
    existing.cachedInputTokens += event.cachedInputTokens
    existing.outputTokens += event.outputTokens
    existing.reasoningOutputTokens += event.reasoningOutputTokens
    existing.totalTokens += event.totalTokens
    existing.estimatedCostUsd = addCost(existing.estimatedCostUsd, event.estimatedCostUsd)
    return
  }

  target.push({
    modelKey: key,
    modelLabel: event.model ?? 'Unknown model',
    eventCount: 1,
    inputTokens: event.inputTokens,
    cachedInputTokens: event.cachedInputTokens,
    outputTokens: event.outputTokens,
    reasoningOutputTokens: event.reasoningOutputTokens,
    totalTokens: event.totalTokens,
    estimatedCostUsd: event.estimatedCostUsd
  })
}

function mergeLocationModelBreakdown(
  target: OpenCodeUsageLocationModelBreakdown[],
  event: OpenCodeUsageAttributedEvent
): void {
  const modelKey = event.model ?? 'unknown'
  const existing =
    target.find((entry) => entry.locationKey === event.projectKey && entry.modelKey === modelKey) ??
    null
  if (existing) {
    existing.eventCount++
    existing.inputTokens += event.inputTokens
    existing.cachedInputTokens += event.cachedInputTokens
    existing.outputTokens += event.outputTokens
    existing.reasoningOutputTokens += event.reasoningOutputTokens
    existing.totalTokens += event.totalTokens
    existing.estimatedCostUsd = addCost(existing.estimatedCostUsd, event.estimatedCostUsd)
    return
  }

  target.push({
    locationKey: event.projectKey,
    modelKey,
    modelLabel: event.model ?? 'Unknown model',
    repoId: event.repoId,
    worktreeId: event.worktreeId,
    eventCount: 1,
    inputTokens: event.inputTokens,
    cachedInputTokens: event.cachedInputTokens,
    outputTokens: event.outputTokens,
    reasoningOutputTokens: event.reasoningOutputTokens,
    totalTokens: event.totalTokens,
    estimatedCostUsd: event.estimatedCostUsd
  })
}

function aggregateOpenCodeUsage(events: OpenCodeUsageAttributedEvent[]): {
  sessions: OpenCodeUsageSession[]
  dailyAggregates: OpenCodeUsageDailyAggregate[]
} {
  const sessionsById = new Map<string, OpenCodeUsageSession>()
  const dailyByKey = new Map<string, OpenCodeUsageDailyAggregate>()

  for (const event of events) {
    const session = sessionsById.get(event.sessionId) ?? createEmptySession(event)
    if (!sessionsById.has(event.sessionId)) {
      sessionsById.set(event.sessionId, session)
    }
    if (event.timestamp < session.firstTimestamp) {
      session.firstTimestamp = event.timestamp
    }
    if (event.timestamp >= session.lastTimestamp) {
      session.lastTimestamp = event.timestamp
    }
    session.eventCount++
    session.totalInputTokens += event.inputTokens
    session.totalCachedInputTokens += event.cachedInputTokens
    session.totalOutputTokens += event.outputTokens
    session.totalReasoningOutputTokens += event.reasoningOutputTokens
    session.totalTokens += event.totalTokens
    session.estimatedCostUsd = addCost(session.estimatedCostUsd, event.estimatedCostUsd)
    mergeLocationBreakdown(session.locationBreakdown, event)
    mergeModelBreakdown(session.modelBreakdown, event)
    mergeLocationModelBreakdown(session.locationModelBreakdown, event)

    const dailyKey = [event.day, event.model ?? 'unknown', event.projectKey].join('::')
    const daily = dailyByKey.get(dailyKey) ?? createEmptyDailyAggregate(event)
    if (!dailyByKey.has(dailyKey)) {
      dailyByKey.set(dailyKey, daily)
    }
    daily.eventCount++
    daily.inputTokens += event.inputTokens
    daily.cachedInputTokens += event.cachedInputTokens
    daily.outputTokens += event.outputTokens
    daily.reasoningOutputTokens += event.reasoningOutputTokens
    daily.totalTokens += event.totalTokens
    daily.estimatedCostUsd = addCost(daily.estimatedCostUsd, event.estimatedCostUsd)
  }

  return {
    sessions: finalizeSessions(sessionsById),
    dailyAggregates: [...dailyByKey.values()].sort((left, right) =>
      left.day === right.day
        ? left.projectLabel.localeCompare(right.projectLabel)
        : left.day.localeCompare(right.day)
    )
  }
}

function finalizeSessions(sessionsById: Map<string, OpenCodeUsageSession>): OpenCodeUsageSession[] {
  for (const session of sessionsById.values()) {
    session.locationBreakdown.sort((left, right) => right.totalTokens - left.totalTokens)
    session.modelBreakdown.sort((left, right) => right.totalTokens - left.totalTokens)
    const primaryLocation = session.locationBreakdown[0] ?? null
    const primaryModel = session.modelBreakdown[0] ?? null
    session.primaryProjectLabel =
      session.locationBreakdown.length <= 1
        ? (primaryLocation?.projectLabel ?? 'Unknown location')
        : 'Multiple locations'
    session.hasMixedLocations = session.locationBreakdown.length > 1
    session.primaryWorktreeId = primaryLocation?.worktreeId ?? null
    session.primaryRepoId = primaryLocation?.repoId ?? null
    session.primaryModel =
      session.modelBreakdown.length <= 1 ? (primaryModel?.modelLabel ?? null) : 'Mixed models'
    session.hasMixedModels = session.modelBreakdown.length > 1
  }

  return [...sessionsById.values()].sort((left, right) =>
    right.lastTimestamp.localeCompare(left.lastTimestamp)
  )
}

function mergeSessions(
  target: Map<string, OpenCodeUsageSession>,
  sessions: OpenCodeUsageSession[]
): void {
  for (const session of sessions) {
    const existing = target.get(session.sessionId)
    if (!existing) {
      target.set(session.sessionId, structuredClone(session))
      continue
    }

    existing.firstTimestamp =
      session.firstTimestamp < existing.firstTimestamp
        ? session.firstTimestamp
        : existing.firstTimestamp
    existing.lastTimestamp =
      session.lastTimestamp > existing.lastTimestamp
        ? session.lastTimestamp
        : existing.lastTimestamp
    existing.eventCount += session.eventCount
    existing.totalInputTokens += session.totalInputTokens
    existing.totalCachedInputTokens += session.totalCachedInputTokens
    existing.totalOutputTokens += session.totalOutputTokens
    existing.totalReasoningOutputTokens += session.totalReasoningOutputTokens
    existing.totalTokens += session.totalTokens
    existing.estimatedCostUsd = addCost(existing.estimatedCostUsd, session.estimatedCostUsd)

    for (const location of session.locationBreakdown) {
      const existingLocation =
        existing.locationBreakdown.find((entry) => entry.locationKey === location.locationKey) ??
        null
      if (existingLocation) {
        existingLocation.eventCount += location.eventCount
        existingLocation.inputTokens += location.inputTokens
        existingLocation.cachedInputTokens += location.cachedInputTokens
        existingLocation.outputTokens += location.outputTokens
        existingLocation.reasoningOutputTokens += location.reasoningOutputTokens
        existingLocation.totalTokens += location.totalTokens
        existingLocation.estimatedCostUsd = addCost(
          existingLocation.estimatedCostUsd,
          location.estimatedCostUsd
        )
      } else {
        existing.locationBreakdown.push({ ...location })
      }
    }

    for (const model of session.modelBreakdown) {
      const existingModel =
        existing.modelBreakdown.find((entry) => entry.modelKey === model.modelKey) ?? null
      if (existingModel) {
        existingModel.eventCount += model.eventCount
        existingModel.inputTokens += model.inputTokens
        existingModel.cachedInputTokens += model.cachedInputTokens
        existingModel.outputTokens += model.outputTokens
        existingModel.reasoningOutputTokens += model.reasoningOutputTokens
        existingModel.totalTokens += model.totalTokens
        existingModel.estimatedCostUsd = addCost(
          existingModel.estimatedCostUsd,
          model.estimatedCostUsd
        )
      } else {
        existing.modelBreakdown.push({ ...model })
      }
    }

    for (const locationModel of session.locationModelBreakdown) {
      const existingLocationModel =
        existing.locationModelBreakdown.find(
          (entry) =>
            entry.locationKey === locationModel.locationKey &&
            entry.modelKey === locationModel.modelKey
        ) ?? null
      if (existingLocationModel) {
        existingLocationModel.eventCount += locationModel.eventCount
        existingLocationModel.inputTokens += locationModel.inputTokens
        existingLocationModel.cachedInputTokens += locationModel.cachedInputTokens
        existingLocationModel.outputTokens += locationModel.outputTokens
        existingLocationModel.reasoningOutputTokens += locationModel.reasoningOutputTokens
        existingLocationModel.totalTokens += locationModel.totalTokens
        existingLocationModel.estimatedCostUsd = addCost(
          existingLocationModel.estimatedCostUsd,
          locationModel.estimatedCostUsd
        )
      } else {
        existing.locationModelBreakdown.push({ ...locationModel })
      }
    }
  }
}

function mergeDailyAggregates(
  target: Map<string, OpenCodeUsageDailyAggregate>,
  dailyAggregates: OpenCodeUsageDailyAggregate[]
): void {
  for (const aggregate of dailyAggregates) {
    const key = [aggregate.day, aggregate.model ?? 'unknown', aggregate.projectKey].join('::')
    const existing = target.get(key)
    if (!existing) {
      target.set(key, { ...aggregate })
      continue
    }
    existing.eventCount += aggregate.eventCount
    existing.inputTokens += aggregate.inputTokens
    existing.cachedInputTokens += aggregate.cachedInputTokens
    existing.outputTokens += aggregate.outputTokens
    existing.reasoningOutputTokens += aggregate.reasoningOutputTokens
    existing.totalTokens += aggregate.totalTokens
    existing.estimatedCostUsd = addCost(existing.estimatedCostUsd, aggregate.estimatedCostUsd)
  }
}

export async function parseOpenCodeUsageDatabase(
  dbPath: string,
  worktrees: (OpenCodeUsageWorktreeRef & { canonicalPath: string })[]
): Promise<OpenCodeUsagePersistedDatabase> {
  const processedDatabase = await getProcessedDatabaseInfo(dbPath)
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    db.pragma('query_only = ON')
    const events: OpenCodeUsageAttributedEvent[] = []
    for (const row of selectUsageRows(db)) {
      const parsed = parseOpenCodeUsageRow(row)
      if (!parsed) {
        continue
      }
      const attributed = await attributeOpenCodeUsageEvent(parsed, worktrees)
      if (attributed) {
        events.push(attributed)
      }
    }
    return {
      ...processedDatabase,
      ...aggregateOpenCodeUsage(events)
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
  const processedDatabases: OpenCodeUsagePersistedDatabase[] = []
  const worktreesWithCanonicalPaths = await buildWorktreesWithCanonicalPaths(worktrees)
  const sessionsById = new Map<string, OpenCodeUsageSession>()
  const dailyByKey = new Map<string, OpenCodeUsageDailyAggregate>()

  for (const [index, dbPath] of dbPaths.entries()) {
    const databaseInfo = await getProcessedDatabaseInfo(dbPath)
    const previous = previousByPath.get(dbPath)
    const canReuse =
      previous && previous.mtimeMs === databaseInfo.mtimeMs && previous.size === databaseInfo.size
    const processed = canReuse
      ? previous
      : await parseOpenCodeUsageDatabase(dbPath, worktreesWithCanonicalPaths)

    processedDatabases.push(processed)
    mergeSessions(sessionsById, processed.sessions)
    mergeDailyAggregates(dailyByKey, processed.dailyAggregates)

    if ((index + 1) % YIELD_EVERY_DATABASES === 0) {
      await yieldToEventLoop()
    }
  }

  return {
    processedDatabases,
    sessions: finalizeSessions(sessionsById),
    dailyAggregates: [...dailyByKey.values()].sort((left, right) =>
      left.day === right.day
        ? left.projectLabel.localeCompare(right.projectLabel)
        : left.day.localeCompare(right.day)
    )
  }
}

export function createWorktreeRefs(
  repos: Repo[],
  worktreesByRepo: Map<string, { path: string; worktreeId: string; displayName: string }[]>
): OpenCodeUsageWorktreeRef[] {
  const refs: OpenCodeUsageWorktreeRef[] = []
  for (const repo of repos) {
    for (const worktree of worktreesByRepo.get(repo.id) ?? []) {
      refs.push({
        repoId: repo.id,
        worktreeId: worktree.worktreeId,
        path: worktree.path,
        displayName: worktree.displayName
      })
    }
  }
  return refs
}
