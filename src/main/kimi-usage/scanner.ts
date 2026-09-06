import type { KimiUsageDailyAggregate, KimiUsagePersistedFile, KimiUsageSession } from './types'
import { finalizeSessions, mergeDailyAggregates, sortDailyAggregates } from './aggregation'
import { mergeSessions } from './session-merge'
import {
  buildWorktreesWithCanonicalPaths,
  listKimiStateFiles,
  yieldToEventLoop,
  type KimiUsageWorktreeRef
} from './scanner-paths'
import { getKimiUsageProcessedFileInfo, parseKimiUsageFile } from './wire-parser'

const YIELD_EVERY_FILES = 10

export {
  attributeKimiUsageEvent,
  createWorktreeRefs,
  getKimiSessionsDirectories,
  type KimiUsageWorktreeRef
} from './scanner-paths'

export {
  getKimiUsageProcessedFileInfo,
  parseKimiUsageFile,
  parseKimiWireForUsage
} from './wire-parser'

export async function scanKimiUsageFiles(
  worktrees: KimiUsageWorktreeRef[],
  previousProcessedFiles: KimiUsagePersistedFile[]
): Promise<{
  processedFiles: KimiUsagePersistedFile[]
  sessions: KimiUsageSession[]
  dailyAggregates: KimiUsageDailyAggregate[]
}> {
  const files = await listKimiStateFiles()
  const previousByPath = new Map(previousProcessedFiles.map((file) => [file.path, file]))
  const worktreesWithCanonicalPaths = await buildWorktreesWithCanonicalPaths(worktrees)
  const currentPaths = new Set(files)
  const lostOwnerPath = previousProcessedFiles.some(
    (file) =>
      !currentPaths.has(file.path) &&
      Array.isArray(file.ownedEventKeys) &&
      file.ownedEventKeys.length > 0
  )
  const reusedByPath = new Map<string, KimiUsagePersistedFile>()
  const pathsToParse: string[] = []

  for (const [index, filePath] of files.entries()) {
    const fileInfo = await getKimiUsageProcessedFileInfo(filePath)
    const previous = previousByPath.get(filePath)
    const mustReclaimDeferred = lostOwnerPath && previous?.hasDeferredClaims !== false
    const canReuse =
      !mustReclaimDeferred &&
      previous &&
      previous.mtimeMs === fileInfo.mtimeMs &&
      previous.size === fileInfo.size &&
      previous.wirePath === fileInfo.wirePath &&
      previous.wireMtimeMs === fileInfo.wireMtimeMs &&
      previous.wireSize === fileInfo.wireSize &&
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

  const parsedByPath = await parseChangedFiles(
    pathsToParse,
    reusedByPath,
    worktreesWithCanonicalPaths
  )
  return buildScanResult(files, reusedByPath, parsedByPath)
}

async function parseChangedFiles(
  pathsToParse: string[],
  reusedByPath: ReadonlyMap<string, KimiUsagePersistedFile>,
  worktreesWithCanonicalPaths: (KimiUsageWorktreeRef & { canonicalPath: string })[]
): Promise<Map<string, KimiUsagePersistedFile>> {
  const eventOwnerByKey = new Map<string, string>()
  for (const [filePath, previous] of reusedByPath) {
    for (const eventKey of previous.ownedEventKeys) {
      if (!eventOwnerByKey.has(eventKey)) {
        eventOwnerByKey.set(eventKey, filePath)
      }
    }
  }

  const parsedByPath = new Map<string, KimiUsagePersistedFile>()
  for (const [index, filePath] of pathsToParse.entries()) {
    const processed = await parseKimiUsageFile(filePath, worktreesWithCanonicalPaths, {
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
  return parsedByPath
}

function buildScanResult(
  files: string[],
  reusedByPath: ReadonlyMap<string, KimiUsagePersistedFile>,
  parsedByPath: ReadonlyMap<string, KimiUsagePersistedFile>
): {
  processedFiles: KimiUsagePersistedFile[]
  sessions: KimiUsageSession[]
  dailyAggregates: KimiUsageDailyAggregate[]
} {
  const processedFiles: KimiUsagePersistedFile[] = []
  const sessionsById = new Map<string, KimiUsageSession>()
  const dailyByKey = new Map<string, KimiUsageDailyAggregate>()
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
    dailyAggregates: sortDailyAggregates([...dailyByKey.values()])
  }
}
