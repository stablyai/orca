import { stat } from 'node:fs/promises'
import { attributeUsageEvent } from '../usage/usage-event-attribution'
import { createUsageEventAggregation } from '../usage/usage-event-aggregation'
import { readJsonlLinesFromOffset } from '../usage/jsonl-line-offsets'
import type { UsageScanWorktreeRef } from '../usage/usage-provider-contract'
import {
  createUsageWorktreeResolver,
  type UsageWorktreeResolver
} from '../usage/usage-worktree-resolver'
import { listMuseSessionLogFiles, type MuseSessionLogRef } from './muse-session-log-discovery'
import { parseMuseUsageLine, type MuseUsageParseContext } from './muse-usage-record-parser'
import type {
  MuseUsageAttributedEvent,
  MuseUsageDailyAggregate,
  MuseUsageMetric,
  MuseUsagePersistedFile,
  MuseUsageProcessedFile,
  MuseUsageSession
} from './types'

const YIELD_EVERY_FILES = 10

export const museUsageAggregation = createUsageEventAggregation<
  MuseUsageAttributedEvent,
  MuseUsageMetric
>({
  metric: { empty: () => ({}), fromEvent: () => ({}), fold: () => {} },
  cloneSessionForMerge: (session) => ({
    ...session,
    locationBreakdown: session.locationBreakdown.map((entry) => ({ ...entry })),
    modelBreakdown: session.modelBreakdown.map((entry) => ({ ...entry })),
    locationModelBreakdown: session.locationModelBreakdown.map((entry) => ({ ...entry }))
  })
})

type MuseSessionLogInfo = MuseSessionLogRef & MuseUsageProcessedFile

type MuseUsageFileParseInput = {
  info: MuseUsageProcessedFile
  sessionId: string
  inheritedCwd: string | null
  resolveWorktree: UsageWorktreeResolver
  claimEventKey: (eventKey: string) => boolean
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

async function statSessionLog(ref: MuseSessionLogRef): Promise<MuseSessionLogInfo | null> {
  try {
    const fileStat = await stat(ref.path)
    return fileStat.isFile() ? { ...ref, mtimeMs: fileStat.mtimeMs, size: fileStat.size } : null
  } catch {
    // Session directories may precede logs or use --no-session-log.
    return null
  }
}

export async function parseMuseUsageFile(
  input: MuseUsageFileParseInput
): Promise<MuseUsagePersistedFile> {
  const context: MuseUsageParseContext = {
    sessionId: input.sessionId,
    cwd: input.inheritedCwd,
    currentModel: null
  }
  const events: MuseUsageAttributedEvent[] = []
  const ownedEventKeys = new Set<string>()
  const occurrencesByContentKey = new Map<string, number>()
  let hasDeferredClaims = false
  // A later size change reparses incomplete JSON tail lines.
  for await (const { line } of readJsonlLinesFromOffset(input.info.path, 0)) {
    for (const parsed of parseMuseUsageLine(line, context)) {
      // Ordinals distinguish identical records within one log while preserving fork-copy deduplication.
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
  return {
    path: input.info.path,
    mtimeMs: input.info.mtimeMs,
    size: input.info.size,
    ...museUsageAggregation.aggregate(events),
    ownedEventKeys: [...ownedEventKeys],
    hasDeferredClaims,
    sessionCwd: context.cwd,
    inheritedCwd: input.inheritedCwd
  }
}

export async function scanMuseUsageFiles(
  worktrees: UsageScanWorktreeRef[],
  previousProcessedFiles: MuseUsagePersistedFile[],
  onFilesScanned?: (count: number) => void,
  sessionsDir?: string
): Promise<{
  processedFiles: MuseUsagePersistedFile[]
  sessions: MuseUsageSession[]
  dailyAggregates: MuseUsageDailyAggregate[]
}> {
  const refs = await listMuseSessionLogFiles(sessionsDir)
  const previousByPath = new Map(previousProcessedFiles.map((file) => [file.path, file]))
  const resolveWorktree = await createUsageWorktreeResolver(worktrees)

  const logs: MuseSessionLogInfo[] = []
  for (const [index, ref] of refs.entries()) {
    const info = await statSessionLog(ref)
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

  const isStatUnchanged = (log: MuseSessionLogInfo): boolean => {
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

  const processedByPath = new Map<string, MuseUsagePersistedFile>()
  const cwdBySession = new Map<string, string | null>()
  let parsedCount = 0

  // Resolve parents first: subagent logs omit workspace context.
  for (const pass of [false, true]) {
    const passLogs = logs.filter((log) => log.isSubagent === pass)
    const toParse: { log: MuseSessionLogInfo; inheritedCwd: string | null }[] = []
    for (const log of passLogs) {
      const inheritedCwd = log.isSubagent ? (cwdBySession.get(log.sessionId) ?? null) : null
      const previous = previousByPath.get(log.path)
      if (previous && isStatUnchanged(log) && previous.inheritedCwd === inheritedCwd) {
        processedByPath.set(log.path, previous)
      } else {
        toParse.push({ log, inheritedCwd })
      }
    }

    for (const { log, inheritedCwd } of toParse) {
      try {
        processedByPath.set(
          log.path,
          await parseMuseUsageFile({
            info: log,
            sessionId: log.sessionId,
            inheritedCwd,
            resolveWorktree,
            claimEventKey: claimFor(log.path)
          })
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

    if (!pass) {
      for (const log of passLogs) {
        cwdBySession.set(log.sessionId, processedByPath.get(log.path)?.sessionCwd ?? null)
      }
    }
  }

  const processedFiles: MuseUsagePersistedFile[] = []
  const sessionsById = new Map<string, MuseUsageSession>()
  const dailyByKey = new Map<string, MuseUsageDailyAggregate>()
  for (const log of logs) {
    const processed = processedByPath.get(log.path)
    if (!processed) {
      continue
    }
    processedFiles.push(processed)
    museUsageAggregation.mergeSessions(sessionsById, processed.sessions)
    museUsageAggregation.mergeDailyAggregates(dailyByKey, processed.dailyAggregates)
  }

  return {
    processedFiles,
    sessions: museUsageAggregation.finalizeSessions(sessionsById),
    dailyAggregates: museUsageAggregation.sortDailyAggregates(dailyByKey)
  }
}
