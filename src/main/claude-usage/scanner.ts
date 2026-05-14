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
  message?: {
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
const FILE_SCAN_BATCH_SIZE = 4

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
  try {
    return (await walkJsonlFiles(CLAUDE_PROJECTS_DIR)).sort()
  } catch {
    return []
  }
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
    lineCount
  }
}

export function parseClaudeUsageRecord(line: string): ClaudeUsageParsedTurn | null {
  let parsed: ClaudeUsageSourceRecord
  try {
    parsed = JSON.parse(line) as ClaudeUsageSourceRecord
  } catch {
    return null
  }

  if (parsed.type !== 'assistant') {
    return null
  }
  if (!parsed.sessionId || !parsed.timestamp) {
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
    sessionId: parsed.sessionId,
    timestamp: parsed.timestamp,
    model: parsed.message?.model ?? null,
    cwd: parsed.cwd ?? null,
    gitBranch: parsed.gitBranch ?? null,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens
  }
}

export async function parseClaudeUsageFile(filePath: string): Promise<ClaudeUsageParsedTurn[]> {
  const turns: ClaudeUsageParsedTurn[] = []
  const lines = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity
  })

  for await (const line of lines) {
    const parsed = parseClaudeUsageRecord(line)
    if (parsed) {
      turns.push(parsed)
    }
  }

  return turns
}

async function readClaudeUsageScanFile(filePath: string): Promise<{
  processedFile: ClaudeUsageProcessedFile
  turns: ClaudeUsageParsedTurn[]
}> {
  const fileStat = await stat(filePath)
  let lineCount = 0
  const turns: ClaudeUsageParsedTurn[] = []
  const lines = createInterface({
    input: createReadStream(filePath, { encoding: 'utf-8' }),
    crlfDelay: Infinity
  })

  for await (const line of lines) {
    lineCount++
    const parsed = parseClaudeUsageRecord(line)
    if (parsed) {
      turns.push(parsed)
    }
  }

  return {
    processedFile: {
      path: filePath,
      mtimeMs: fileStat.mtimeMs,
      lineCount
    },
    turns
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
      const worktree = worktreeLookup.get(await canonicalizePath(turn.cwd))
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

  return {
    sessions: [...sessionsById.values()].sort((left, right) =>
      right.lastTimestamp.localeCompare(left.lastTimestamp)
    ),
    dailyAggregates: [...dailyByKey.values()].sort((left, right) =>
      left.day === right.day
        ? left.projectLabel.localeCompare(right.projectLabel)
        : left.day.localeCompare(right.day)
    )
  }
}

export async function scanClaudeUsageFiles(worktrees: ClaudeUsageWorktreeRef[]): Promise<{
  processedFiles: ClaudeUsageProcessedFile[]
  sessions: ClaudeUsageSession[]
  dailyAggregates: ClaudeUsageDailyAggregate[]
}> {
  const files = await listClaudeTranscriptFiles()
  const processedFiles: ClaudeUsageProcessedFile[] = []
  const allTurns: ClaudeUsageParsedTurn[] = []
  const worktreeLookup = await buildWorktreeLookup(worktrees)

  for (let index = 0; index < files.length; index += FILE_SCAN_BATCH_SIZE) {
    const batch = files.slice(index, index + FILE_SCAN_BATCH_SIZE)
    const results = await Promise.all(batch.map((filePath) => readClaudeUsageScanFile(filePath)))
    for (const result of results) {
      processedFiles.push(result.processedFile)
      allTurns.push(...result.turns)
    }
    // Why: transcript scans run in Electron's main process. Small parallel
    // batches cut independent file I/O without letting Settings stay blocked.
    if (index + batch.length < files.length) {
      await yieldToEventLoop()
    }
  }

  const attributed = await attributeClaudeUsageTurns(allTurns, worktreeLookup)
  return {
    processedFiles,
    ...aggregateClaudeUsage(attributed)
  }
}

export function getClaudeProjectsDirectory(): string {
  return CLAUDE_PROJECTS_DIR
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
