import {
  buildJsonlFileCheckpoint,
  openJsonlFileReader,
  resolveJsonlFileCheckpoint,
  validateJsonlFileReader,
  type JsonlFileReader
} from '../usage/jsonl-file-checkpoint'
import { readJsonlLinesFromOffset } from '../usage/jsonl-line-offsets'
import { readJsonlFileSnapshot, type JsonlFileSnapshot } from '../usage/jsonl-file-snapshot'
import type { UsageScanResult, UsageScanWorktreeRef } from '../usage/usage-provider-contract'
import {
  readUsageSourceCache,
  writeUsageSourceCache,
  type UsageSourceCacheRef
} from '../usage/usage-source-cache-file'
import {
  createUsageWorktreeResolver,
  type UsageWorktreeResolver
} from '../usage/usage-worktree-resolver'
import {
  addOmpDailyAggregate,
  combineOmpSessions,
  mergeAppendedFile
} from './omp-usage-aggregation'
import {
  applyOmpUsageLine,
  createOmpUsageParseAccumulator,
  createOmpUsageParseContext,
  finalizeOmpSessions
} from './transcript-record-parser'
import { listOmpSessionFiles, yieldToEventLoop } from './transcript-file-discovery'
import type { OmpUsageDailyAggregate, OmpUsagePersistedFile, OmpUsageSession } from './types'

const YIELD_EVERY_FILES = 10

/** Mutable projections so a store can persist them without copying the scan result. */
export type OmpUsageScanResult = UsageScanResult<OmpUsageSession, OmpUsageDailyAggregate> & {
  sessions: OmpUsageSession[]
  dailyAggregates: OmpUsageDailyAggregate[]
}

async function scanOmpSessionFile(
  filePath: string,
  previous: OmpUsagePersistedFile | undefined,
  resolveWorktree: UsageWorktreeResolver
): Promise<OmpUsagePersistedFile | null> {
  let fileStat: JsonlFileSnapshot
  try {
    fileStat = await readJsonlFileSnapshot(filePath)
  } catch {
    return null
  }
  if (previous && previous.mtimeMs === fileStat.mtimeMs && previous.size === fileStat.size) {
    return previous
  }

  let resumeState = previous?.parseResumeState ?? null
  let mergePrevious = resumeState ? previous : undefined

  for (;;) {
    let reader: JsonlFileReader
    try {
      reader = await openJsonlFileReader(filePath)
    } catch {
      return null
    }
    try {
      if (
        resumeState &&
        (await resolveJsonlFileCheckpoint(filePath, resumeState, reader)) === null
      ) {
        resumeState = null
        mergePrevious = undefined
        continue
      }

      const context = createOmpUsageParseContext(filePath, resumeState)
      const accumulator = createOmpUsageParseAccumulator()
      let parsedBytes = resumeState?.parsedBytes ?? 0
      for await (const { line, endOffset, terminated } of readJsonlLinesFromOffset(
        filePath,
        parsedBytes,
        reader
      )) {
        if (!terminated) {
          // A partially written tail is skipped until a later append terminates it.
          continue
        }
        parsedBytes = endOffset
        applyOmpUsageLine(line, context, accumulator)
      }

      if (!(await validateJsonlFileReader(reader, resumeState))) {
        resumeState = null
        mergePrevious = undefined
        continue
      }

      const checkpoint = await buildJsonlFileCheckpoint(
        filePath,
        parsedBytes,
        resumeState?.headDigest ?? null,
        reader
      )
      const processed: OmpUsagePersistedFile = {
        path: filePath,
        mtimeMs: reader.stats.mtimeMs,
        size: reader.stats.size,
        sessions: finalizeOmpSessions(context, accumulator, resolveWorktree),
        dailyAggregates: [...accumulator.dailyByDay.values()].sort((left, right) =>
          left.day.localeCompare(right.day)
        ),
        ...(checkpoint
          ? { parseResumeState: { ...checkpoint, ...context } }
          : { parseResumeState: null })
      }
      return mergePrevious ? mergeAppendedFile(mergePrevious, processed) : processed
    } finally {
      await reader.handle.close()
    }
  }
}

export async function scanOmpUsageFiles(
  worktrees: UsageScanWorktreeRef[],
  sourceCache: UsageSourceCacheRef
): Promise<OmpUsageScanResult> {
  const files = await listOmpSessionFiles()
  const previousByPath = new Map(
    (await readUsageSourceCache<OmpUsagePersistedFile>(sourceCache)).map((file) => [
      file.path,
      file
    ])
  )
  const resolveWorktree = await createUsageWorktreeResolver(worktrees)
  const processedFiles: OmpUsagePersistedFile[] = []
  const sessionsById = new Map<string, OmpUsageSession>()
  const dailyByDay = new Map<string, OmpUsageDailyAggregate>()

  for (const [index, filePath] of files.entries()) {
    const processed = await scanOmpSessionFile(
      filePath,
      previousByPath.get(filePath),
      resolveWorktree
    )
    if (processed) {
      processedFiles.push(processed)
      for (const session of processed.sessions) {
        const existing = sessionsById.get(session.sessionId)
        sessionsById.set(
          session.sessionId,
          existing ? combineOmpSessions(existing, session) : { ...session }
        )
      }
      for (const aggregate of processed.dailyAggregates) {
        addOmpDailyAggregate(dailyByDay, aggregate)
      }
    }
    if ((index + 1) % YIELD_EVERY_FILES === 0) {
      await yieldToEventLoop()
    }
  }

  try {
    await writeUsageSourceCache(sourceCache, processedFiles)
  } catch (error) {
    // Cache persistence failure must not fail a successful scan; the next run starts colder.
    console.warn('[omp-usage] Could not persist the omp usage source cache:', error)
  }

  return {
    sessions: [...sessionsById.values()].sort((left, right) =>
      right.startedAt.localeCompare(left.startedAt)
    ),
    dailyAggregates: [...dailyByDay.values()].sort((left, right) =>
      left.day.localeCompare(right.day)
    )
  }
}
