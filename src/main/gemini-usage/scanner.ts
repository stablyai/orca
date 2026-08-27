import { dirname } from 'node:path'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createInterface, type Interface } from 'node:readline'
import { canonicalizeUsageWorktreePaths } from '../usage-worktree-canonicalizer'
import { createUsageEventAggregation } from '../usage/usage-event-aggregation'
import { addCost } from './gemini-usage-cost-estimate'
import {
  canonicalizePath,
  extractSessionIdFromPath,
  listGeminiSessionFiles,
  loadAntigravityHistory,
  yieldToEventLoop
} from './gemini-session-file-discovery'
import {
  attributeGeminiUsageEvent,
  type GeminiUsageWorktreeRef
} from './gemini-usage-event-attribution'
import { parseGeminiJsonDocument } from './gemini-usage-document-parser'
import { parseGeminiUsageRecord, type GeminiUsageParseContext } from './gemini-usage-record-parser'
import type {
  GeminiUsageAttributedEvent,
  GeminiUsageDailyAggregate,
  GeminiUsagePersistedFile,
  GeminiUsageProcessedFile,
  GeminiUsageSession
} from './types'

const YIELD_EVERY_FILES = 10

export async function getProcessedFileInfo(filePath: string): Promise<GeminiUsageProcessedFile> {
  try {
    const fileStat = await stat(filePath)
    return {
      path: filePath,
      mtimeMs: fileStat.mtimeMs,
      size: fileStat.size
    }
  } catch {
    return {
      path: filePath,
      mtimeMs: 0,
      size: 0
    }
  }
}

async function buildWorktreesWithCanonicalPaths(
  worktrees: GeminiUsageWorktreeRef[]
): Promise<(GeminiUsageWorktreeRef & { canonicalPath: string })[]> {
  return canonicalizeUsageWorktreePaths(worktrees, canonicalizePath)
}

type GeminiUsageMetric = {
  hasInferredPricing: boolean
  estimatedCostUsd: number | null
}

const geminiUsageAggregation = createUsageEventAggregation<
  GeminiUsageAttributedEvent,
  GeminiUsageMetric
>({
  metric: {
    empty: () => ({ hasInferredPricing: false, estimatedCostUsd: null }),
    fromEvent: (event) => ({
      hasInferredPricing: event.hasInferredPricing,
      estimatedCostUsd: event.estimatedCostUsd
    }),
    fold: (target, source) => {
      target.hasInferredPricing ||= source.hasInferredPricing
      target.estimatedCostUsd = addCost(target.estimatedCostUsd, source.estimatedCostUsd)
    }
  },
  cloneSessionForMerge: (session) => ({
    ...session,
    locationBreakdown: session.locationBreakdown.map((entry) => ({ ...entry })),
    modelBreakdown: session.modelBreakdown.map((entry) => ({ ...entry })),
    locationModelBreakdown: session.locationModelBreakdown.map((entry) => ({ ...entry }))
  })
})

const { finalizeSessions, mergeSessions, mergeDailyAggregates, sortDailyAggregates } =
  geminiUsageAggregation

export async function parseGeminiUsageFile(
  filePath: string,
  worktrees: (GeminiUsageWorktreeRef & { canonicalPath: string })[],
  options: { claimEventKey?: (eventKey: string) => boolean; historyMap?: Map<string, string> } = {}
): Promise<GeminiUsagePersistedFile> {
  const processedFile = await getProcessedFileInfo(filePath)
  const baseSessionId = extractSessionIdFromPath(filePath)
  const historyMap = options.historyMap ?? (await loadAntigravityHistory(filePath))

  const events: GeminiUsageAttributedEvent[] = []
  const context: GeminiUsageParseContext = {
    sessionId: baseSessionId,
    sessionCwd: historyMap.get(baseSessionId) ?? null,
    currentCwd: null,
    currentModel: null,
    previousTotals: null
  }

  const isJson = filePath.endsWith('.json')
  const ownedEventKeys = new Set<string>()
  let hasDeferredClaims = false
  if (isJson) {
    let content = ''
    try {
      content = await readFile(filePath, 'utf-8')
    } catch {
      return {
        ...processedFile,
        ...geminiUsageAggregation.aggregate([]),
        ownedEventKeys: [],
        hasDeferredClaims: false
      }
    }

    const parsedEvents = parseGeminiJsonDocument(content, context)
    for (const parsed of parsedEvents) {
      if (options.claimEventKey && !options.claimEventKey(parsed.eventKey)) {
        hasDeferredClaims = true
        continue
      }
      ownedEventKeys.add(parsed.eventKey)
      const attributed = await attributeGeminiUsageEvent(parsed, worktrees)
      if (attributed) {
        events.push(attributed)
      }
    }
  } else {
    let lines: Interface
    try {
      lines = createInterface({
        input: createReadStream(filePath, { encoding: 'utf-8' }),
        crlfDelay: Infinity
      })
    } catch {
      return {
        ...processedFile,
        ...geminiUsageAggregation.aggregate([]),
        ownedEventKeys: [],
        hasDeferredClaims: false
      }
    }

    for await (const line of lines) {
      const parsed = parseGeminiUsageRecord(line, context)
      if (!parsed) {
        continue
      }
      if (options.claimEventKey && !options.claimEventKey(parsed.eventKey)) {
        hasDeferredClaims = true
        continue
      }
      ownedEventKeys.add(parsed.eventKey)
      const attributed = await attributeGeminiUsageEvent(parsed, worktrees)
      if (attributed) {
        events.push(attributed)
      }
    }
  }

  return {
    ...processedFile,
    ...geminiUsageAggregation.aggregate(events),
    ownedEventKeys: [...ownedEventKeys],
    hasDeferredClaims
  }
}

export async function scanGeminiUsageFiles(
  worktrees: GeminiUsageWorktreeRef[],
  previousProcessedFiles: GeminiUsagePersistedFile[]
): Promise<{
  processedFiles: GeminiUsagePersistedFile[]
  sessions: GeminiUsageSession[]
  dailyAggregates: GeminiUsageDailyAggregate[]
}> {
  const files = await listGeminiSessionFiles()
  const historyCache = new Map<string, Map<string, string>>()
  const previousByPath = new Map(previousProcessedFiles.map((file) => [file.path, file]))
  const worktreesWithCanonicalPaths = await buildWorktreesWithCanonicalPaths(worktrees)

  const currentPaths = new Set(files)
  const lostOwnerPath = previousProcessedFiles.some(
    (file) =>
      !currentPaths.has(file.path) &&
      Array.isArray(file.ownedEventKeys) &&
      file.ownedEventKeys.length > 0
  )

  const reusedByPath = new Map<string, GeminiUsagePersistedFile>()
  const pathsToParse: string[] = []
  for (const [index, filePath] of files.entries()) {
    const fileInfo = await getProcessedFileInfo(filePath)
    const previous = previousByPath.get(filePath)
    const mustReclaimDeferred = lostOwnerPath && previous?.hasDeferredClaims !== false
    const canReuse =
      !mustReclaimDeferred &&
      previous &&
      previous.mtimeMs === fileInfo.mtimeMs &&
      previous.size === fileInfo.size &&
      Array.isArray(previous.ownedEventKeys) &&
      typeof previous.hasDeferredClaims === 'boolean'
    if (canReuse) {
      reusedByPath.set(filePath, previous)
    } else {
      pathsToParse.push(filePath)
    }
    if ((index + 1) % YIELD_EVERY_FILES === 0) {
      await yieldToEventLoop()
    }
  }

  const eventOwnerByKey = new Map<string, string>()
  for (const [filePath, previous] of reusedByPath) {
    for (const eventKey of previous.ownedEventKeys) {
      if (!eventOwnerByKey.has(eventKey)) {
        eventOwnerByKey.set(eventKey, filePath)
      }
    }
  }

  const parsedByPath = new Map<string, GeminiUsagePersistedFile>()
  for (const [index, filePath] of pathsToParse.entries()) {
    const dirKey = dirname(filePath)
    let historyMap = historyCache.get(dirKey)
    if (!historyMap) {
      historyMap = await loadAntigravityHistory(filePath)
      historyCache.set(dirKey, historyMap)
    }
    const processed = await parseGeminiUsageFile(filePath, worktreesWithCanonicalPaths, {
      historyMap,
      claimEventKey: (eventKey) => {
        const owner = eventOwnerByKey.get(eventKey)
        if (owner !== undefined && owner !== filePath) {
          return false
        }
        eventOwnerByKey.set(eventKey, filePath)
        return true
      }
    })
    parsedByPath.set(filePath, processed)

    if ((index + 1) % YIELD_EVERY_FILES === 0) {
      await yieldToEventLoop()
    }
  }

  const processedFiles: GeminiUsagePersistedFile[] = []
  const sessionsById = new Map<string, GeminiUsageSession>()
  const dailyByKey = new Map<string, GeminiUsageDailyAggregate>()
  for (const filePath of files) {
    const processed = reusedByPath.get(filePath) ?? parsedByPath.get(filePath)
    if (!processed) {
      continue
    }
    processedFiles.push(processed)
    mergeSessions(sessionsById, processed.sessions)
    mergeDailyAggregates(dailyByKey, processed.dailyAggregates)
  }

  return {
    processedFiles,
    sessions: finalizeSessions(sessionsById),
    dailyAggregates: sortDailyAggregates(dailyByKey)
  }
}
