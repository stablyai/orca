import { basename } from 'node:path'
import { stat } from 'node:fs/promises'
import { attributeUsageEvent } from '../usage/usage-event-attribution'
import { addUsageCost } from '../usage/usage-cost'
import { createUsageEventAggregation } from '../usage/usage-event-aggregation'
import { readJsonlLinesFromOffset } from '../usage/jsonl-line-offsets'
import type { UsageScanWorktreeRef } from '../usage/usage-provider-contract'
import {
  createUsageWorktreeResolver,
  type UsageWorktreeResolver
} from '../usage/usage-worktree-resolver'
import { listPiSessionLogFiles } from './pi-session-log-discovery'
import { parsePiUsageLine, type PiUsageParseContext } from './pi-usage-record-parser'
import type {
  PiUsageAttributedEvent,
  PiUsageDailyAggregate,
  PiUsageMetric,
  PiUsagePersistedFile,
  PiUsageProcessedFile,
  PiUsageSession
} from './types'

const YIELD_EVERY_FILES = 10

export const piUsageAggregation = createUsageEventAggregation<
  PiUsageAttributedEvent,
  PiUsageMetric
>({
  metric: {
    empty: () => ({ estimatedCostUsd: null }),
    fromEvent: (event) => ({ estimatedCostUsd: event.estimatedCostUsd }),
    fold: (target, source) => {
      target.estimatedCostUsd = addUsageCost(target.estimatedCostUsd, source.estimatedCostUsd)
    }
  },
  cloneSessionForMerge: (session) => ({
    ...session,
    locationBreakdown: session.locationBreakdown.map((entry) => ({ ...entry })),
    modelBreakdown: session.modelBreakdown.map((entry) => ({ ...entry })),
    locationModelBreakdown: session.locationModelBreakdown.map((entry) => ({ ...entry }))
  })
})

type PiUsageFileParseInput = {
  info: PiUsageProcessedFile
  resolveWorktree: UsageWorktreeResolver
  claimEventKey: (eventKey: string) => boolean
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

async function statSessionLog(path: string): Promise<PiUsageProcessedFile | null> {
  try {
    const fileStat = await stat(path)
    return fileStat.isFile() ? { path, mtimeMs: fileStat.mtimeMs, size: fileStat.size } : null
  } catch {
    return null
  }
}

// Log names end in _<session id>.jsonl; the header id wins when present.
function sessionIdFromLogName(path: string): string {
  const stem = basename(path, '.jsonl')
  return stem.slice(stem.lastIndexOf('_') + 1) || stem
}

export async function parsePiUsageFile(
  input: PiUsageFileParseInput
): Promise<PiUsagePersistedFile> {
  const context: PiUsageParseContext = {
    sessionId: sessionIdFromLogName(input.info.path),
    cwd: null,
    isOmpLog: false
  }
  const events: PiUsageAttributedEvent[] = []
  const ownedEventKeys = new Set<string>()
  const occurrencesByContentKey = new Map<string, number>()
  let hasDeferredClaims = false
  // A later size change reparses incomplete JSON tail lines.
  for await (const { line } of readJsonlLinesFromOffset(input.info.path, 0)) {
    for (const parsed of parsePiUsageLine(line, context)) {
      // Ordinals keep identical records within one log while forks still deduplicate.
      const occurrence = occurrencesByContentKey.get(parsed.eventKey) ?? 0
      occurrencesByContentKey.set(parsed.eventKey, occurrence + 1)
      const eventKey = `${parsed.eventKey}#${occurrence}`
      if (!input.claimEventKey(eventKey)) {
        hasDeferredClaims = true
        continue
      }
      ownedEventKeys.add(eventKey)
      const attributed = attributeUsageEvent(parsed, input.resolveWorktree)
      if (attributed) {
        events.push(attributed)
      }
    }
  }
  // OMP markers can follow usage lines; an OMP log contributes nothing to Pi.
  const ownEvents = context.isOmpLog ? [] : events
  return {
    path: input.info.path,
    mtimeMs: input.info.mtimeMs,
    size: input.info.size,
    ...piUsageAggregation.aggregate(ownEvents),
    ownedEventKeys: context.isOmpLog ? [] : [...ownedEventKeys],
    hasDeferredClaims
  }
}

export async function scanPiUsageFiles(
  worktrees: UsageScanWorktreeRef[],
  previousProcessedFiles: PiUsagePersistedFile[],
  onFilesScanned?: (count: number) => void,
  sessionsDir?: string
): Promise<{
  processedFiles: PiUsagePersistedFile[]
  sessions: PiUsageSession[]
  dailyAggregates: PiUsageDailyAggregate[]
}> {
  const paths = await listPiSessionLogFiles(sessionsDir)
  const previousByPath = new Map(previousProcessedFiles.map((file) => [file.path, file]))
  const resolveWorktree = await createUsageWorktreeResolver(worktrees)

  const logs: PiUsageProcessedFile[] = []
  for (const [index, path] of paths.entries()) {
    const info = await statSessionLog(path)
    if (info) {
      logs.push(info)
    }
    if ((index + 1) % YIELD_EVERY_FILES === 0) {
      await yieldToEventLoop()
    }
  }

  const currentPaths = new Set(logs.map((log) => log.path))
  // Deleted owners free claims; reparse only files that previously deferred to them.
  const lostOwnerPath = previousProcessedFiles.some(
    (file) => !currentPaths.has(file.path) && file.ownedEventKeys.length > 0
  )
  const eventOwnerByKey = new Map<string, string>()
  const claimFor =
    (path: string) =>
    (eventKey: string): boolean => {
      const owner = eventOwnerByKey.get(eventKey)
      if (owner !== undefined && owner !== path) {
        return false
      }
      eventOwnerByKey.set(eventKey, path)
      return true
    }

  const isStatUnchanged = (log: PiUsageProcessedFile): boolean => {
    const previous = previousByPath.get(log.path)
    const mustReclaimDeferred = lostOwnerPath && previous?.hasDeferredClaims !== false
    return (
      previous !== undefined &&
      !mustReclaimDeferred &&
      previous.mtimeMs === log.mtimeMs &&
      previous.size === log.size
    )
  }
  // Register retained ownership before reparsing so other files cannot steal claims.
  for (const log of logs) {
    if (isStatUnchanged(log)) {
      for (const eventKey of previousByPath.get(log.path)?.ownedEventKeys ?? []) {
        if (!eventOwnerByKey.has(eventKey)) {
          eventOwnerByKey.set(eventKey, log.path)
        }
      }
    }
  }

  const processedByPath = new Map<string, PiUsagePersistedFile>()
  let parsedCount = 0
  for (const log of logs) {
    const previous = previousByPath.get(log.path)
    if (previous && isStatUnchanged(log)) {
      processedByPath.set(log.path, previous)
      continue
    }
    try {
      processedByPath.set(
        log.path,
        await parsePiUsageFile({ info: log, resolveWorktree, claimEventKey: claimFor(log.path) })
      )
    } catch {
      // Retry vanished or unreadable logs on the next scan.
    }
    onFilesScanned?.(1)
    parsedCount++
    if (parsedCount % YIELD_EVERY_FILES === 0) {
      await yieldToEventLoop()
    }
  }

  const processedFiles: PiUsagePersistedFile[] = []
  const sessionsById = new Map<string, PiUsageSession>()
  const dailyByKey = new Map<string, PiUsageDailyAggregate>()
  for (const log of logs) {
    const processed = processedByPath.get(log.path)
    if (!processed) {
      continue
    }
    processedFiles.push(processed)
    piUsageAggregation.mergeSessions(sessionsById, processed.sessions)
    piUsageAggregation.mergeDailyAggregates(dailyByKey, processed.dailyAggregates)
  }

  return {
    processedFiles,
    sessions: piUsageAggregation.finalizeSessions(sessionsById),
    dailyAggregates: piUsageAggregation.sortDailyAggregates(dailyByKey)
  }
}
