import { createReadStream } from 'fs'
import { readdir, readFile, stat } from 'fs/promises'
import { join } from 'path'
import { createInterface } from 'readline'
import {
  kimiPrimaryAgentWirePath,
  kimiSessionIdFromStatePath,
  kimiSessionIndexPathFromStatePath,
  readKimiWorkDirBySessionId,
  resolveKimiSessionsDir
} from '../ai-vault/session-scanner-kimi-paths'
import {
  asRecord,
  extractString,
  numberValue,
  parseJsonObject
} from '../ai-vault/session-scanner-values'
import {
  attributeKimiUsageEvent,
  buildWorktreesWithCanonicalPaths,
  type KimiUsageWorktreeRef
} from './event-attribution'
import { aggregateKimiUsage, finalizeSessions } from './session-aggregation'
import { mergeDailyAggregates, mergeSessions } from './usage-state-merging'
import type {
  KimiUsageAttributedEvent,
  KimiUsageDailyAggregate,
  KimiUsageParsedEvent,
  KimiUsagePersistedFile,
  KimiUsageProcessedFile,
  KimiUsageSession
} from './types'

export { createWorktreeRefs } from './event-attribution'

export type KimiUsageSessionFile = KimiUsageProcessedFile & {
  statePath: string
}

const YIELD_EVERY_FILES = 10
const YIELD_EVERY_DISCOVERY_ENTRIES = 100

async function yieldToEventLoop(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function readStateRecord(statePath: string): Promise<Record<string, unknown> | null> {
  try {
    return asRecord(JSON.parse(await readFile(statePath, 'utf-8')) as unknown)
  } catch {
    return null
  }
}

async function discoverStatePaths(sessionsDir: string): Promise<string[]> {
  const statePaths: string[] = []
  let visited = 0
  try {
    const workspaceEntries = await readdir(sessionsDir, { withFileTypes: true })
    for (const workspaceEntry of workspaceEntries) {
      if (!workspaceEntry.isDirectory() || !workspaceEntry.name.startsWith('wd_')) {
        continue
      }
      const workspaceDir = join(sessionsDir, workspaceEntry.name)
      const sessionEntries = await readdir(workspaceDir, { withFileTypes: true })
      for (const sessionEntry of sessionEntries) {
        if (sessionEntry.isDirectory() && sessionEntry.name.startsWith('session_')) {
          statePaths.push(join(workspaceDir, sessionEntry.name, 'state.json'))
        }
        visited++
        if (visited % YIELD_EVERY_DISCOVERY_ENTRIES === 0) {
          await yieldToEventLoop()
        }
      }
    }
  } catch {
    return []
  }
  return statePaths.sort()
}

export async function listKimiUsageSessionFiles(
  override?: string
): Promise<KimiUsageSessionFile[]> {
  const files: KimiUsageSessionFile[] = []
  // Why: this reads+parses every session's state.json and stats its wire file
  // on each scan (it feeds the reuse check, so it runs even when files are
  // reused). Yield periodically so a large Kimi history can't stall the main
  // process when Settings → Stats triggers a scan.
  for (const [index, statePath] of (
    await discoverStatePaths(resolveKimiSessionsDir(override))
  ).entries()) {
    if (index > 0 && index % YIELD_EVERY_DISCOVERY_ENTRIES === 0) {
      await yieldToEventLoop()
    }
    const stateRecord = await readStateRecord(statePath)
    if (!stateRecord) {
      continue
    }
    const wirePath = kimiPrimaryAgentWirePath(statePath, stateRecord)
    try {
      const wireStat = await stat(wirePath)
      if (wireStat.isFile()) {
        files.push({
          statePath,
          path: wirePath,
          mtimeMs: wireStat.mtimeMs,
          size: wireStat.size
        })
      }
    } catch {
      continue
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

function normalizeEpochMillis(value: unknown): string | null {
  const numeric = numberValue(value)
  return numeric > 0 ? new Date(numeric).toISOString() : null
}

function fallbackTimestamp(stateRecord: Record<string, unknown> | null): string | null {
  return extractString(stateRecord?.updatedAt) ?? extractString(stateRecord?.createdAt)
}

function parseKimiUsageEvent(args: {
  record: Record<string, unknown>
  sessionId: string
  cwd: string | null
  fallbackTimestamp: string | null
  latestModel: string | null
}): KimiUsageParsedEvent | null {
  if (args.record.usageScope === 'session') {
    return null
  }
  const usage = asRecord(args.record.usage)
  if (!usage) {
    return null
  }
  const inputTokens = numberValue(usage.inputOther)
  const cachedInputTokens =
    numberValue(usage.inputCacheRead) + numberValue(usage.inputCacheCreation)
  const outputTokens = numberValue(usage.output)
  const timestamp = normalizeEpochMillis(args.record.time) ?? args.fallbackTimestamp
  if (!timestamp) {
    return null
  }
  return {
    sessionId: args.sessionId,
    timestamp,
    cwd: args.cwd,
    model: args.latestModel,
    estimatedCostUsd: null,
    inputTokens,
    cachedInputTokens,
    outputTokens,
    reasoningOutputTokens: 0,
    totalTokens: inputTokens + cachedInputTokens + outputTokens
  }
}

async function getProcessedFileInfo(file: KimiUsageSessionFile): Promise<KimiUsageProcessedFile> {
  try {
    const wireStat = await stat(file.path)
    return {
      path: file.path,
      mtimeMs: wireStat.mtimeMs,
      size: wireStat.size
    }
  } catch {
    return {
      path: file.path,
      mtimeMs: file.mtimeMs,
      size: file.size
    }
  }
}

export async function parseKimiUsageWire(
  file: KimiUsageSessionFile,
  worktrees: (KimiUsageWorktreeRef & { canonicalPath: string })[]
): Promise<KimiUsagePersistedFile> {
  const processedFile = await getProcessedFileInfo(file)
  const stateRecord = await readStateRecord(file.statePath)
  if (!stateRecord) {
    return { ...processedFile, sessions: [], dailyAggregates: [] }
  }
  const sessionId = kimiSessionIdFromStatePath(file.statePath)
  const workDirBySessionId = await readKimiWorkDirBySessionId(
    kimiSessionIndexPathFromStatePath(file.statePath)
  )
  const cwd = workDirBySessionId.get(sessionId) ?? null
  const fallback = fallbackTimestamp(stateRecord)
  let configModel: string | null = null
  let usageModel: string | null = null
  const events: KimiUsageAttributedEvent[] = []

  try {
    const lines = createInterface({
      input: createReadStream(file.path, { encoding: 'utf-8' }),
      crlfDelay: Infinity
    })
    for await (const line of lines) {
      const record = parseJsonObject(line)
      if (!record) {
        continue
      }
      if (record.type === 'config.update') {
        configModel = extractString(record.modelAlias) ?? configModel
        continue
      }
      if (record.type !== 'usage.record') {
        continue
      }
      usageModel = extractString(record.model) ?? usageModel
      const parsed = parseKimiUsageEvent({
        record,
        sessionId,
        cwd,
        fallbackTimestamp: fallback,
        latestModel: usageModel ?? configModel
      })
      if (!parsed) {
        continue
      }
      const attributed = await attributeKimiUsageEvent(parsed, worktrees)
      if (attributed) {
        events.push(attributed)
      }
    }
  } catch {
    return { ...processedFile, sessions: [], dailyAggregates: [] }
  }

  return {
    ...processedFile,
    ...aggregateKimiUsage(events)
  }
}

export async function scanKimiUsage(
  worktrees: KimiUsageWorktreeRef[],
  previousProcessedFiles: KimiUsagePersistedFile[]
): Promise<{
  processedFiles: KimiUsagePersistedFile[]
  sessions: KimiUsageSession[]
  dailyAggregates: KimiUsageDailyAggregate[]
}> {
  const files = await listKimiUsageSessionFiles()
  const previousByPath = new Map(previousProcessedFiles.map((file) => [file.path, file]))
  const processedFiles: KimiUsagePersistedFile[] = []
  const worktreesWithCanonicalPaths = await buildWorktreesWithCanonicalPaths(worktrees)
  const sessionsById = new Map<string, KimiUsageSession>()
  const dailyByKey = new Map<string, KimiUsageDailyAggregate>()

  for (const [index, file] of files.entries()) {
    const previous = previousByPath.get(file.path)
    const canReuse = previous && previous.mtimeMs === file.mtimeMs && previous.size === file.size
    const processed = canReuse
      ? previous
      : await parseKimiUsageWire(file, worktreesWithCanonicalPaths)

    processedFiles.push(processed)
    mergeSessions(sessionsById, processed.sessions)
    mergeDailyAggregates(dailyByKey, processed.dailyAggregates)

    if ((index + 1) % YIELD_EVERY_FILES === 0) {
      await yieldToEventLoop()
    }
  }

  return {
    processedFiles,
    sessions: finalizeSessions(sessionsById),
    dailyAggregates: [...dailyByKey.values()].sort((left, right) =>
      left.day === right.day
        ? left.projectLabel.localeCompare(right.projectLabel)
        : left.day.localeCompare(right.day)
    )
  }
}
