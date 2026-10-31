import { createUsageWorktreeResolver } from '../usage/usage-worktree-resolver'
import {
  getLegacySourceSkipBytesByPath,
  listCodexSessionFiles,
  yieldToEventLoop
} from './codex-session-file-discovery'
import type { CodexUsageWorktreeRef } from './codex-usage-event-attribution'
import { codexUsageAggregation } from './codex-usage-aggregation'
import { getProcessedFileInfo, parseCodexUsageFile } from './codex-rollout-file-parse'
import { resolveCodexRolloutResume } from './codex-rollout-resume-state'
import type {
  CodexUsageDailyAggregate,
  CodexUsageParseResumeState,
  CodexUsagePersistedFile,
  CodexUsageSession
} from './types'

const YIELD_EVERY_FILES = 10

const { finalizeSessions, mergeSessions, mergeDailyAggregates, sortDailyAggregates } =
  codexUsageAggregation

type CodexRolloutResumePlan = {
  state: CodexUsageParseResumeState
  previous: CodexUsagePersistedFile
}

export async function scanCodexUsageFiles(
  worktrees: CodexUsageWorktreeRef[],
  previousProcessedFiles: CodexUsagePersistedFile[],
  onFilesScanned?: (count: number) => void
): Promise<{
  processedFiles: CodexUsagePersistedFile[]
  sessions: CodexUsageSession[]
  dailyAggregates: CodexUsageDailyAggregate[]
}> {
  const files = await listCodexSessionFiles()
  const previousByPath = new Map(previousProcessedFiles.map((file) => [file.path, file]))
  // Share the per-cwd attribution cache across all files in this scan.
  const resolveWorktree = await createUsageWorktreeResolver(worktrees)
  const legacySourceSkipBytesByPath = getLegacySourceSkipBytesByPath(files)

  const currentPaths = new Set(files)
  // Deleted owners release copied records; reparse only forks that deferred those claims.
  const lostOwnerPath = previousProcessedFiles.some(
    (file) =>
      !currentPaths.has(file.path) &&
      Array.isArray(file.ownedEventKeys) &&
      file.ownedEventKeys.length > 0
  )

  const reusedByPath = new Map<string, CodexUsagePersistedFile>()
  const resumeByPath = new Map<string, CodexRolloutResumePlan>()
  const pathsToParse: string[] = []
  for (const [index, filePath] of files.entries()) {
    const legacySourceSkipBytes = legacySourceSkipBytesByPath.get(filePath) ?? 0
    const fileInfo = await getProcessedFileInfo(filePath)
    const previous = previousByPath.get(filePath)
    const mustReclaimDeferred = lostOwnerPath && previous?.hasDeferredClaims !== false
    const hasGenerationMetadata =
      previous &&
      typeof previous.ctimeMs === 'number' &&
      (typeof previous.physicalFileId === 'string' || previous.physicalFileId === null)
    const canReuse =
      !mustReclaimDeferred &&
      legacySourceSkipBytes === 0 &&
      previous &&
      hasGenerationMetadata &&
      previous.mtimeMs === fileInfo.mtimeMs &&
      previous.size === fileInfo.size &&
      previous.ctimeMs === fileInfo.ctimeMs &&
      previous.physicalFileId === fileInfo.physicalFileId &&
      Array.isArray(previous.ownedEventKeys) &&
      typeof previous.hasDeferredClaims === 'boolean'
    if (canReuse) {
      reusedByPath.set(filePath, previous)
    } else {
      // Resume growing rollouts; reclaims and legacy suffix parses require fresh context.
      if (
        !mustReclaimDeferred &&
        legacySourceSkipBytes === 0 &&
        previous &&
        hasGenerationMetadata &&
        fileInfo.size > previous.size
      ) {
        const state = await resolveCodexRolloutResume(filePath, previous)
        if (state) {
          resumeByPath.set(filePath, { state, previous })
        }
      }
      pathsToParse.push(filePath)
    }
    onFilesScanned?.(1)
    if ((index + 1) % YIELD_EVERY_FILES === 0) {
      await yieldToEventLoop()
    }
  }

  // Forks copy usage records; retained claims and sorted-path parsing prevent double-counting.
  const eventOwnerByKey = new Map<string, string>()
  for (const filePath of files) {
    const retained = previousByPath.get(filePath)
    for (const eventKey of retained?.ownedEventKeys ?? []) {
      // First retained claim wins so conflicting projections stay deterministic.
      if (!eventOwnerByKey.has(eventKey)) {
        eventOwnerByKey.set(eventKey, filePath)
      }
    }
  }

  const parsedByPath = new Map<string, CodexUsagePersistedFile>()
  let lostOwnerKeys = lostOwnerPath
  const parseAndPublish = async (
    filePath: string,
    resume?: CodexRolloutResumePlan
  ): Promise<void> => {
    const previous =
      parsedByPath.get(filePath) ?? reusedByPath.get(filePath) ?? previousByPath.get(filePath)
    const processed = await parseCodexUsageFile(filePath, resolveWorktree, {
      legacySourceSkipBytes: legacySourceSkipBytesByPath.get(filePath) ?? 0,
      resume,
      canClaimEventKey: (eventKey) => {
        const owner = eventOwnerByKey.get(eventKey)
        return owner === undefined || owner === filePath
      },
      commitEventKey: (eventKey) => {
        eventOwnerByKey.set(eventKey, filePath)
      }
    })
    const currentKeys = new Set(processed.ownedEventKeys)
    for (const key of previous?.ownedEventKeys ?? []) {
      if (eventOwnerByKey.get(key) === filePath && !currentKeys.has(key)) {
        eventOwnerByKey.delete(key)
        lostOwnerKeys = true
      }
    }
    reusedByPath.delete(filePath)
    parsedByPath.set(filePath, processed)
  }

  for (const [index, filePath] of pathsToParse.entries()) {
    await parseAndPublish(filePath, resumeByPath.get(filePath))

    // Yield so large histories do not monopolize the scan worker.
    onFilesScanned?.(1)
    if ((index + 1) % YIELD_EVERY_FILES === 0) {
      await yieldToEventLoop()
    }
  }

  // A replaced owner can release records that an unchanged fork previously deferred.
  while (lostOwnerKeys) {
    lostOwnerKeys = false
    for (const [index, filePath] of files.entries()) {
      const current = parsedByPath.get(filePath) ?? reusedByPath.get(filePath)
      if (current?.hasDeferredClaims) {
        await parseAndPublish(filePath)
        onFilesScanned?.(1)
      }
      if ((index + 1) % YIELD_EVERY_FILES === 0) {
        await yieldToEventLoop()
      }
    }
  }

  const processedFiles: CodexUsagePersistedFile[] = []
  const sessionsById = new Map<string, CodexUsageSession>()
  const dailyByKey = new Map<string, CodexUsageDailyAggregate>()
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
