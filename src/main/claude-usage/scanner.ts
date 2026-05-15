/* eslint-disable max-lines -- Why: transcript discovery, parsing, attribution, and aggregation share one data shape pipeline. Keeping them co-located makes it easier to audit correctness when Claude usage numbers look surprising. */
import { homedir } from 'os'
import { join, basename } from 'path'
import { realpath, readdir, stat } from 'fs/promises'
import { createReadStream } from 'fs'
import { createInterface } from 'readline'
import type { Repo } from '../../shared/types'
import type {
  ClaudeUsageAttributedTurn,
  ClaudeUsageDailyAggregate,
  ClaudeUsageLocationBreakdown,
  ClaudeUsageParsedTurn,
  ClaudeUsagePersistedFile,
  ClaudeUsageProcessedFile,
  ClaudeUsageSession
} from './types'

export type ClaudeUsageWorktreeRef = {
  repoId: string
  worktreeId: string
  path: string
  displayName: string
}

type ClaudeUsageSourceRecord = {
  type?: string
  sessionId?: string
  timestamp?: string
  cwd?: string
  gitBranch?: string
  requestId?: string
  isSidechain?: boolean
  agentId?: string
  message?: {
    id?: string
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
}

const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects')
const CLAUDE_TRANSCRIPTS_DIR = join(homedir(), '.claude', 'transcripts')
const FILE_SCAN_BATCH_SIZE = 4

type ClaudeUsageParsedSourceTurn = ClaudeUsageParsedTurn & {
  dedupeKey: string | null
}

type ClaudeUsageWorktreeEntry = [string, ClaudeUsageWorktreeRef]

const sortedWorktreeEntriesByLookup = new WeakMap<
  Map<string, ClaudeUsageWorktreeRef>,
  ClaudeUsageWorktreeEntry[]
>()

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

async function canonicalizePath(pathValue: string): Promise<string> {
  try {
    const resolved = await realpath(pathValue)
    return normalizeComparablePath(resolved)
  } catch {
    return normalizeComparablePath(pathValue)
  }
}

function normalizeComparablePath(pathValue: string): string {
  const normalized = pathValue.replace(/\\/g, '/')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

function isContainedPath(parentPath: string, childPath: string): boolean {
  const parent = normalizeComparablePath(parentPath).replace(/\/+$/, '')
  const child = normalizeComparablePath(childPath).replace(/\/+$/, '')
  return child === parent || child.startsWith(`${parent}/`)
}

function findContainingWorktree(
  cwd: string,
  worktreeLookup: Map<string, ClaudeUsageWorktreeRef>
): ClaudeUsageWorktreeRef | null {
  const normalizedCwd = normalizeComparablePath(cwd)
  const exact = worktreeLookup.get(normalizedCwd)
  if (exact) {
    return exact
  }

  for (const [worktreePath, worktree] of getSortedWorktreeEntries(worktreeLookup)) {
    if (isContainedPath(worktreePath, normalizedCwd)) {
      return worktree
    }
  }

  return null
}

function getSortedWorktreeEntries(
  worktreeLookup: Map<string, ClaudeUsageWorktreeRef>
): ClaudeUsageWorktreeEntry[] {
  const cached = sortedWorktreeEntriesByLookup.get(worktreeLookup)
  if (cached) {
    return cached
  }
  const sorted = [...worktreeLookup.entries()].sort(
    ([leftPath], [rightPath]) => rightPath.length - leftPath.length
  )
  sortedWorktreeEntriesByLookup.set(worktreeLookup, sorted)
  return sorted
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function walkJsonlFiles(dirPath: string): Promise<string[]> {
  const entries = await readdir(dirPath, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await walkJsonlFiles(fullPath)))
      continue
    }
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      files.push(fullPath)
    }
  }

  return files
}

export async function listClaudeTranscriptFiles(): Promise<string[]> {
  const roots = [CLAUDE_PROJECTS_DIR, CLAUDE_TRANSCRIPTS_DIR]
  const files = await Promise.all(
    roots.map(async (root) => {
      try {
        return await walkJsonlFiles(root)
      } catch {
        return []
      }
    })
  )
  return [...new Set(files.flat())].sort()
}

export async function getProcessedFileInfo(filePath: string): Promise<ClaudeUsageProcessedFile> {
  const fileStat = await stat(filePath)
  let lineCount = 0
  const lines = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity
  })
  for await (const _line of lines) {
    lineCount++
  }
  return {
    path: filePath,
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
    lineCount
  }
}

async function getProcessedFileStat(
  filePath: string
): Promise<Omit<ClaudeUsageProcessedFile, 'lineCount'>> {
  const fileStat = await stat(filePath)
  return {
    path: filePath,
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size
  }
}

function stripClaudeSourceMetadata(turn: ClaudeUsageParsedSourceTurn): ClaudeUsageParsedTurn {
  return {
    sessionId: turn.sessionId,
    timestamp: turn.timestamp,
    model: turn.model,
    cwd: turn.cwd,
    gitBranch: turn.gitBranch,
    inputTokens: turn.inputTokens,
    outputTokens: turn.outputTokens,
    cacheReadTokens: turn.cacheReadTokens,
    cacheWriteTokens: turn.cacheWriteTokens
  }
}

function dedupeClaudeUsageTurns(turns: ClaudeUsageParsedSourceTurn[]): ClaudeUsageParsedTurn[] {
  const dedupeIndexByKey = new Map<string, number>()
  const deduped: ClaudeUsageParsedTurn[] = []

  for (const turn of turns) {
    if (turn.dedupeKey) {
      const existingIndex = dedupeIndexByKey.get(turn.dedupeKey)
      if (existingIndex !== undefined) {
        const existing = deduped[existingIndex]
        // Why: Claude Code streams repeated assistant rows with the same
        // message/request IDs; later rows can contain more complete usage.
        existing.inputTokens = Math.max(existing.inputTokens, turn.inputTokens)
        existing.outputTokens = Math.max(existing.outputTokens, turn.outputTokens)
        existing.cacheReadTokens = Math.max(existing.cacheReadTokens, turn.cacheReadTokens)
        existing.cacheWriteTokens = Math.max(existing.cacheWriteTokens, turn.cacheWriteTokens)
        continue
      }
    }

    const stripped = stripClaudeSourceMetadata(turn)
    deduped.push(stripped)
    if (turn.dedupeKey) {
      dedupeIndexByKey.set(turn.dedupeKey, deduped.length - 1)
    }
  }

  return deduped
}

function parseClaudeUsageSourceRecord(
  line: string,
  fallbackSessionId: string | null = null
): ClaudeUsageParsedSourceTurn | null {
  let parsed: ClaudeUsageSourceRecord
  try {
    parsed = JSON.parse(line) as ClaudeUsageSourceRecord
  } catch {
    return null
  }

  if (parsed.type !== 'assistant') {
    return null
  }
  const sessionId = parsed.sessionId ?? fallbackSessionId
  if (!sessionId || !parsed.timestamp) {
    return null
  }

  const usage = parsed.message?.usage
  const inputTokens = usage?.input_tokens ?? 0
  const outputTokens = usage?.output_tokens ?? 0
  const cacheReadTokens = usage?.cache_read_input_tokens ?? 0
  const cacheWriteTokens = usage?.cache_creation_input_tokens ?? 0

  if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens <= 0) {
    return null
  }

  return {
    sessionId,
    timestamp: parsed.timestamp,
    model: parsed.message?.model ?? null,
    cwd: parsed.cwd ?? null,
    gitBranch: parsed.gitBranch ?? null,
    dedupeKey:
      parsed.message?.id && parsed.requestId ? `${parsed.message.id}:${parsed.requestId}` : null,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens
  }
}

export function parseClaudeUsageRecord(line: string): ClaudeUsageParsedTurn | null {
  const parsed = parseClaudeUsageSourceRecord(line)
  return parsed ? stripClaudeSourceMetadata(parsed) : null
}

export async function parseClaudeUsageFile(filePath: string): Promise<ClaudeUsageParsedTurn[]> {
  const turns: ClaudeUsageParsedSourceTurn[] = []
  const fallbackSessionId = basename(filePath, '.jsonl')
  const lines = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity
  })

  for await (const line of lines) {
    const parsed = parseClaudeUsageSourceRecord(line, fallbackSessionId)
    if (parsed) {
      turns.push(parsed)
    }
  }

  return dedupeClaudeUsageTurns(turns)
}

async function readClaudeUsageScanFile(filePath: string): Promise<{
  processedFile: ClaudeUsageProcessedFile
  turns: ClaudeUsageParsedTurn[]
}> {
  const fileStat = await stat(filePath)
  let lineCount = 0
  const turns: ClaudeUsageParsedSourceTurn[] = []
  const fallbackSessionId = basename(filePath, '.jsonl')
  const lines = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity
  })

  for await (const line of lines) {
    lineCount++
    const parsed = parseClaudeUsageSourceRecord(line, fallbackSessionId)
    if (parsed) {
      turns.push(parsed)
    }
  }

  return {
    processedFile: {
      path: filePath,
      mtimeMs: fileStat.mtimeMs,
      size: fileStat.size,
      lineCount
    },
    turns: dedupeClaudeUsageTurns(turns)
  }
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

export async function buildWorktreeLookup(
  worktrees: ClaudeUsageWorktreeRef[]
): Promise<Map<string, ClaudeUsageWorktreeRef>> {
  const lookup = new Map<string, ClaudeUsageWorktreeRef>()
  for (const worktree of worktrees) {
    lookup.set(await canonicalizePath(worktree.path), worktree)
  }
  return lookup
}

export async function attributeClaudeUsageTurns(
  turns: ClaudeUsageParsedTurn[],
  worktreeLookup: Map<string, ClaudeUsageWorktreeRef>
): Promise<ClaudeUsageAttributedTurn[]> {
  const attributed: ClaudeUsageAttributedTurn[] = []
  const canonicalCwdByPath = new Map<string, string>()

  for (const turn of turns) {
    const day = localDayFromTimestamp(turn.timestamp)
    if (!day) {
      continue
    }

    let repoId: string | null = null
    let worktreeId: string | null = null
    let projectKey = 'unscoped'
    let projectLabel = getDefaultProjectLabel(turn.cwd)

    if (turn.cwd) {
      let canonicalCwd = canonicalCwdByPath.get(turn.cwd)
      if (canonicalCwd === undefined) {
        // Why: Claude transcripts repeat the same cwd for many consecutive
        // turns. Cache realpath work so attribution scales with unique paths.
        canonicalCwd = await canonicalizePath(turn.cwd)
        canonicalCwdByPath.set(turn.cwd, canonicalCwd)
      }
      const worktree = findContainingWorktree(canonicalCwd, worktreeLookup)
      if (worktree) {
        repoId = worktree.repoId
        worktreeId = worktree.worktreeId
        projectKey = `worktree:${worktreeId}`
        projectLabel = worktree.displayName
      } else {
        projectKey = `cwd:${normalizeComparablePath(turn.cwd)}`
      }
    }

    attributed.push({
      ...turn,
      day,
      projectKey,
      projectLabel,
      repoId,
      worktreeId
    })
  }

  return attributed
}

function mergeClaudeSessions(
  target: Map<string, ClaudeUsageSession>,
  sessions: ClaudeUsageSession[]
): void {
  for (const session of sessions) {
    const existing = target.get(session.sessionId)
    if (!existing) {
      target.set(session.sessionId, structuredClone(session))
      continue
    }

    if (session.firstTimestamp < existing.firstTimestamp) {
      existing.firstTimestamp = session.firstTimestamp
    }
    if (session.lastTimestamp > existing.lastTimestamp) {
      existing.lastTimestamp = session.lastTimestamp
      existing.lastCwd = session.lastCwd
      existing.lastGitBranch = session.lastGitBranch
    }
    existing.model = session.model ?? existing.model
    existing.turnCount += session.turnCount
    existing.totalInputTokens += session.totalInputTokens
    existing.totalOutputTokens += session.totalOutputTokens
    existing.totalCacheReadTokens += session.totalCacheReadTokens
    existing.totalCacheWriteTokens += session.totalCacheWriteTokens

    for (const location of session.locationBreakdown) {
      const existingLocation =
        existing.locationBreakdown.find((entry) => entry.locationKey === location.locationKey) ??
        null
      if (existingLocation) {
        existingLocation.turnCount += location.turnCount
        existingLocation.inputTokens += location.inputTokens
        existingLocation.outputTokens += location.outputTokens
        existingLocation.cacheReadTokens += location.cacheReadTokens
        existingLocation.cacheWriteTokens += location.cacheWriteTokens
      } else {
        existing.locationBreakdown.push({ ...location })
      }
    }
  }
}

function mergeClaudeDailyAggregates(
  target: Map<string, ClaudeUsageDailyAggregate>,
  dailyAggregates: ClaudeUsageDailyAggregate[]
): void {
  for (const aggregate of dailyAggregates) {
    const key = [aggregate.day, aggregate.model ?? 'unknown', aggregate.projectKey].join('::')
    const existing = target.get(key)
    if (!existing) {
      target.set(key, { ...aggregate })
      continue
    }
    existing.turnCount += aggregate.turnCount
    existing.zeroCacheReadTurnCount += aggregate.zeroCacheReadTurnCount
    existing.inputTokens += aggregate.inputTokens
    existing.outputTokens += aggregate.outputTokens
    existing.cacheReadTokens += aggregate.cacheReadTokens
    existing.cacheWriteTokens += aggregate.cacheWriteTokens
  }
}

function finalizeClaudeSessions(
  sessionsById: Map<string, ClaudeUsageSession>
): ClaudeUsageSession[] {
  for (const session of sessionsById.values()) {
    session.locationBreakdown.sort((left, right) => {
      const leftTotal = left.inputTokens + left.outputTokens
      const rightTotal = right.inputTokens + right.outputTokens
      return rightTotal - leftTotal
    })
    const primaryLocation = session.locationBreakdown[0] ?? null
    if (primaryLocation) {
      session.primaryRepoId = primaryLocation.repoId
      session.primaryWorktreeId = primaryLocation.worktreeId
    }
  }

  return [...sessionsById.values()].sort((left, right) =>
    right.lastTimestamp.localeCompare(left.lastTimestamp)
  )
}

export function aggregateClaudeUsage(turns: ClaudeUsageAttributedTurn[]): {
  sessions: ClaudeUsageSession[]
  dailyAggregates: ClaudeUsageDailyAggregate[]
} {
  const sessionsById = new Map<string, ClaudeUsageSession>()
  const dailyByKey = new Map<string, ClaudeUsageDailyAggregate>()

  for (const turn of turns) {
    const existingSession = sessionsById.get(turn.sessionId)
    if (!existingSession) {
      sessionsById.set(turn.sessionId, {
        sessionId: turn.sessionId,
        firstTimestamp: turn.timestamp,
        lastTimestamp: turn.timestamp,
        model: turn.model,
        lastCwd: turn.cwd,
        lastGitBranch: turn.gitBranch,
        primaryWorktreeId: turn.worktreeId,
        primaryRepoId: turn.repoId,
        turnCount: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        locationBreakdown: []
      })
    }

    const session = sessionsById.get(turn.sessionId)!
    if (turn.timestamp < session.firstTimestamp) {
      session.firstTimestamp = turn.timestamp
    }
    if (turn.timestamp > session.lastTimestamp) {
      session.lastTimestamp = turn.timestamp
      session.lastCwd = turn.cwd
      session.lastGitBranch = turn.gitBranch
    }
    session.model = turn.model ?? session.model
    session.turnCount++
    session.totalInputTokens += turn.inputTokens
    session.totalOutputTokens += turn.outputTokens
    session.totalCacheReadTokens += turn.cacheReadTokens
    session.totalCacheWriteTokens += turn.cacheWriteTokens

    const location =
      session.locationBreakdown.find((entry) => entry.locationKey === turn.projectKey) ?? null
    if (location) {
      location.turnCount++
      location.inputTokens += turn.inputTokens
      location.outputTokens += turn.outputTokens
      location.cacheReadTokens += turn.cacheReadTokens
      location.cacheWriteTokens += turn.cacheWriteTokens
    } else {
      session.locationBreakdown.push({
        locationKey: turn.projectKey,
        projectLabel: turn.projectLabel,
        repoId: turn.repoId,
        worktreeId: turn.worktreeId,
        turnCount: 1,
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        cacheReadTokens: turn.cacheReadTokens,
        cacheWriteTokens: turn.cacheWriteTokens
      })
    }

    const dailyKey = [turn.day, turn.model ?? 'unknown', turn.projectKey].join('::')
    const existingDaily = dailyByKey.get(dailyKey)
    if (existingDaily) {
      existingDaily.turnCount++
      if (turn.cacheReadTokens === 0) {
        existingDaily.zeroCacheReadTurnCount++
      }
      existingDaily.inputTokens += turn.inputTokens
      existingDaily.outputTokens += turn.outputTokens
      existingDaily.cacheReadTokens += turn.cacheReadTokens
      existingDaily.cacheWriteTokens += turn.cacheWriteTokens
    } else {
      dailyByKey.set(dailyKey, {
        day: turn.day,
        model: turn.model,
        projectKey: turn.projectKey,
        projectLabel: turn.projectLabel,
        repoId: turn.repoId,
        worktreeId: turn.worktreeId,
        turnCount: 1,
        zeroCacheReadTurnCount: turn.cacheReadTokens === 0 ? 1 : 0,
        inputTokens: turn.inputTokens,
        outputTokens: turn.outputTokens,
        cacheReadTokens: turn.cacheReadTokens,
        cacheWriteTokens: turn.cacheWriteTokens
      })
    }
  }

  return {
    sessions: finalizeClaudeSessions(sessionsById),
    dailyAggregates: [...dailyByKey.values()].sort((left, right) =>
      left.day === right.day
        ? left.projectLabel.localeCompare(right.projectLabel)
        : left.day.localeCompare(right.day)
    )
  }
}

async function parseClaudeUsagePersistedFile(
  filePath: string,
  worktreeLookup: Map<string, ClaudeUsageWorktreeRef>
): Promise<ClaudeUsagePersistedFile> {
  const { processedFile, turns } = await readClaudeUsageScanFile(filePath)
  const attributed = await attributeClaudeUsageTurns(turns, worktreeLookup)
  return {
    ...processedFile,
    ...aggregateClaudeUsage(attributed)
  }
}

export async function scanClaudeUsageFiles(
  worktrees: ClaudeUsageWorktreeRef[],
  previousProcessedFiles: ClaudeUsagePersistedFile[] = []
): Promise<{
  processedFiles: ClaudeUsagePersistedFile[]
  sessions: ClaudeUsageSession[]
  dailyAggregates: ClaudeUsageDailyAggregate[]
}> {
  const files = await listClaudeTranscriptFiles()
  const previousByPath = new Map(previousProcessedFiles.map((file) => [file.path, file]))
  const processedFiles: ClaudeUsagePersistedFile[] = []
  const worktreeLookup = await buildWorktreeLookup(worktrees)
  const sessionsById = new Map<string, ClaudeUsageSession>()
  const dailyByKey = new Map<string, ClaudeUsageDailyAggregate>()

  for (let index = 0; index < files.length; index += FILE_SCAN_BATCH_SIZE) {
    const batch = files.slice(index, index + FILE_SCAN_BATCH_SIZE)
    const results = await Promise.all(
      batch.map(async (filePath) => {
        const fileInfo = await getProcessedFileStat(filePath)
        const previous = previousByPath.get(filePath)
        // Why: Claude histories can be gigabytes. Unchanged files should pay
        // only stat cost on refresh while preserving exactly the old projection.
        const canReuse =
          previous &&
          previous.mtimeMs === fileInfo.mtimeMs &&
          previous.size === fileInfo.size &&
          Array.isArray(previous.sessions) &&
          Array.isArray(previous.dailyAggregates)

        return canReuse ? previous : parseClaudeUsagePersistedFile(filePath, worktreeLookup)
      })
    )
    for (const processed of results) {
      processedFiles.push(processed)
      mergeClaudeSessions(sessionsById, processed.sessions)
      mergeClaudeDailyAggregates(dailyByKey, processed.dailyAggregates)
    }
    // Why: transcript scans run in Electron's main process. Small parallel
    // batches cut independent file I/O without letting Settings stay blocked.
    if (index + batch.length < files.length) {
      await yieldToEventLoop()
    }
  }

  return {
    processedFiles,
    sessions: finalizeClaudeSessions(sessionsById),
    dailyAggregates: [...dailyByKey.values()].sort((left, right) =>
      left.day === right.day
        ? left.projectLabel.localeCompare(right.projectLabel)
        : left.day.localeCompare(right.day)
    )
  }
}

export function getClaudeProjectsDirectory(): string {
  return CLAUDE_PROJECTS_DIR
}

export function getClaudeTranscriptsDirectory(): string {
  return CLAUDE_TRANSCRIPTS_DIR
}

export function createWorktreeRefs(
  repos: Repo[],
  worktreesByRepo: Map<string, { path: string; worktreeId: string; displayName: string }[]>
): ClaudeUsageWorktreeRef[] {
  const refs: ClaudeUsageWorktreeRef[] = []
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

export function getSessionProjectLabel(locationBreakdown: ClaudeUsageLocationBreakdown[]): string {
  if (locationBreakdown.length === 0) {
    return 'Unknown location'
  }
  if (locationBreakdown.length === 1) {
    return locationBreakdown[0].projectLabel
  }
  return 'Multiple locations'
}

export function getDefaultWorktreeLabel(pathValue: string): string {
  return basename(pathValue)
}
