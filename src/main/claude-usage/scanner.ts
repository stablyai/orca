import { stat } from 'node:fs/promises'
import type {
  ClaudeUsageDailyAggregate,
  ClaudeUsageParsedTurn,
  ClaudeUsagePersistedFile,
  ClaudeUsageProcessedFile,
  ClaudeUsageSession
} from './types'
import { listClaudeTranscriptFiles } from './transcript-file-discovery'
import { readClaudeUsageScanFile, stripClaudeSourceMetadata } from './transcript-record-parser'
import {
  attributeClaudeUsageTurns,
  buildWorktreeLookup,
  type ClaudeUsageWorktreeRef
} from './worktree-attribution'
import {
  aggregateClaudeUsage,
  finalizeClaudeSessions,
  mergeClaudeDailyAggregates,
  mergeClaudeSessions
} from './usage-aggregation'

const FILE_SCAN_BATCH_SIZE = 4

// Why setImmediate: setTimeout(0) is clamped to ~1ms, and this yields once per
// 4-file batch, so a 7.5k-transcript scan spent ~2s parked on timers.
async function yieldToEventLoop(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
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
  const worktreeLookup = await buildWorktreeLookup(worktrees)

  const currentPaths = new Set(files)
  // Why: when a file that owned dedupe keys is deleted, remaining forks still
  // contain those turns but their caches record them as unowned. Only files
  // that previously deferred claims can reclaim, so invalidate those — not the
  // entire transcript corpus (histories can be gigabytes).
  const lostOwnerPath = previousProcessedFiles.some(
    (file) =>
      !currentPaths.has(file.path) &&
      Array.isArray(file.ownedDedupeKeys) &&
      file.ownedDedupeKeys.length > 0
  )

  const reusedByPath = new Map<string, ClaudeUsagePersistedFile>()
  const pathsToParse: string[] = []
  for (let index = 0; index < files.length; index += FILE_SCAN_BATCH_SIZE) {
    const batch = files.slice(index, index + FILE_SCAN_BATCH_SIZE)
    const reusable = await Promise.all(
      batch.map(async (filePath) => {
        const fileInfo = await getProcessedFileStat(filePath)
        const previous = previousByPath.get(filePath)
        // Why: Claude histories can be gigabytes. Unchanged files should pay
        // only stat cost on refresh while preserving exactly the old projection.
        // When an owner disappears, only deferred-claim files need reparse.
        const mustReclaimDeferred = lostOwnerPath && previous?.hasDeferredClaims !== false
        const canReuse =
          !mustReclaimDeferred &&
          previous &&
          previous.mtimeMs === fileInfo.mtimeMs &&
          previous.size === fileInfo.size &&
          Array.isArray(previous.sessions) &&
          Array.isArray(previous.dailyAggregates) &&
          Array.isArray(previous.ownedDedupeKeys) &&
          typeof previous.hasDeferredClaims === 'boolean'
        return canReuse ? previous : null
      })
    )
    for (const [batchIndex, previous] of reusable.entries()) {
      if (previous) {
        reusedByPath.set(batch[batchIndex], previous)
      } else {
        pathsToParse.push(batch[batchIndex])
      }
    }
    if (index + batch.length < files.length) {
      await yieldToEventLoop()
    }
  }

  // Why: resuming or forking a Claude session copies earlier turns — with their
  // original message/request IDs — into a new transcript file under a new
  // session id. Per-file dedupe cannot see those copies, so long-lived sessions
  // get re-counted on every fork (issue #8006). Cross-file ownership counts each
  // turn for exactly one file; cached files keep the claims they persisted.
  const turnOwnerByDedupeKey = new Map<string, string>()
  for (const [filePath, previous] of reusedByPath) {
    for (const dedupeKey of previous.ownedDedupeKeys) {
      // First cached claim wins so conflicting projections stay deterministic.
      if (!turnOwnerByDedupeKey.has(dedupeKey)) {
        turnOwnerByDedupeKey.set(dedupeKey, filePath)
      }
    }
  }

  const parsedByPath = new Map<string, ClaudeUsagePersistedFile>()
  for (let index = 0; index < pathsToParse.length; index += FILE_SCAN_BATCH_SIZE) {
    const batch = pathsToParse.slice(index, index + FILE_SCAN_BATCH_SIZE)
    // Why: transcript scans run in Electron's main process. Small parallel
    // batches cut independent file I/O without letting Settings stay blocked.
    const reads = await Promise.all(batch.map((filePath) => readClaudeUsageScanFile(filePath)))
    for (const [batchIndex, filePath] of batch.entries()) {
      const { processedFile, turns } = reads[batchIndex]
      // Why: ownership claims must be sequential in sorted-path order so
      // rescans assign duplicated turns to the same file deterministically.
      const ownedTurns: ClaudeUsageParsedTurn[] = []
      const ownedDedupeKeys: string[] = []
      let hasDeferredClaims = false
      for (const turn of turns) {
        if (turn.dedupeKey) {
          const owner = turnOwnerByDedupeKey.get(turn.dedupeKey)
          if (owner !== undefined && owner !== filePath) {
            hasDeferredClaims = true
            continue
          }
          turnOwnerByDedupeKey.set(turn.dedupeKey, filePath)
          ownedDedupeKeys.push(turn.dedupeKey)
        }
        ownedTurns.push(stripClaudeSourceMetadata(turn))
      }
      const attributed = await attributeClaudeUsageTurns(ownedTurns, worktreeLookup)
      parsedByPath.set(filePath, {
        ...processedFile,
        ...aggregateClaudeUsage(attributed),
        ownedDedupeKeys,
        hasDeferredClaims
      })
    }
    if (index + batch.length < pathsToParse.length) {
      await yieldToEventLoop()
    }
  }

  const processedFiles: ClaudeUsagePersistedFile[] = []
  const sessionsById = new Map<string, ClaudeUsageSession>()
  const dailyByKey = new Map<string, ClaudeUsageDailyAggregate>()
  for (const filePath of files) {
    const processed = reusedByPath.get(filePath) ?? parsedByPath.get(filePath)
    if (!processed) {
      continue
    }
    processedFiles.push(processed)
    mergeClaudeSessions(sessionsById, processed.sessions)
    mergeClaudeDailyAggregates(dailyByKey, processed.dailyAggregates)
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
