import type {
  ClaudeUsageDailyAggregate,
  ClaudeUsageParseResumeState,
  ClaudeUsagePersistedFile,
  ClaudeUsageSession
} from './types'
import { listClaudeTranscriptFiles } from './transcript-file-discovery'
import {
  getClaudeUsageProcessedFileStat,
  readClaudeUsageScanFile,
  type ClaudeUsageParsedSourceTurn,
  type ClaudeUsageScanFile
} from './transcript-record-parser'
import { buildWorktreeLookup, type ClaudeUsageWorktreeRef } from './worktree-attribution'
import {
  finalizeClaudeSessions,
  mergeClaudeDailyAggregates,
  mergeClaudeSessions
} from './usage-aggregation'
import {
  CLAUDE_USAGE_PROJECTION_VERSION,
  projectClaudeUsageScanFile,
  createClaudeUsageTokenReconciler,
  type ClaudeUsageTokenReconciler
} from './transcript-usage-projection'
import {
  normalizeClaudeUsageSourceFiles,
  type ClaudeUsageVerifiedSources
} from './persisted-projection-validation'

const FILE_SCAN_BATCH_SIZE = 4

type ClaudeUsageFilePlan = {
  previous: ClaudeUsagePersistedFile | undefined
  reusable: boolean
  resume: ClaudeUsageParseResumeState | null
}

async function planClaudeUsageFile(
  filePath: string,
  previous: ClaudeUsagePersistedFile | undefined,
  resumable: ReadonlySet<ClaudeUsagePersistedFile>
): Promise<ClaudeUsageFilePlan> {
  const fileInfo = await getClaudeUsageProcessedFileStat(filePath)
  const validProjection =
    previous &&
    Array.isArray(previous.sessions) &&
    Array.isArray(previous.dailyAggregates) &&
    Array.isArray(previous.ownedDedupeKeys) &&
    typeof previous.hasDeferredClaims === 'boolean' &&
    previous.projectionVersion === CLAUDE_USAGE_PROJECTION_VERSION
  const previousId = previous?.physicalFileId ?? previous?.parseResumeState?.physicalFileId
  const reusable = Boolean(
    validProjection &&
    previous.physicalFileId !== undefined &&
    typeof previous.ctimeMs === 'number' &&
    previous.mtimeMs === fileInfo.mtimeMs &&
    previous.size === fileInfo.size &&
    (previous.ctimeMs === undefined || previous.ctimeMs === fileInfo.ctimeMs) &&
    (!previousId || !fileInfo.physicalFileId || previousId === fileInfo.physicalFileId)
  )
  const resume =
    !reusable && validProjection && fileInfo.size > previous.size && resumable.has(previous)
      ? previous.parseResumeState
      : null
  return {
    previous,
    reusable,
    resume: resume && previous?.parseResumeState ? previous.parseResumeState : null
  }
}

async function yieldToEventLoop(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

export async function scanClaudeUsageFiles(
  worktrees: ClaudeUsageWorktreeRef[],
  previousProcessedFiles: ClaudeUsagePersistedFile[] = [],
  onFilesScanned?: (count: number) => void,
  profileDirs?: string[],
  verifiedSources?: ClaudeUsageVerifiedSources
): Promise<{
  processedFiles: ClaudeUsagePersistedFile[]
  sessions: ClaudeUsageSession[]
  dailyAggregates: ClaudeUsageDailyAggregate[]
}> {
  const files = await listClaudeTranscriptFiles(profileDirs)
  const normalized = normalizeClaudeUsageSourceFiles(previousProcessedFiles, verifiedSources)
  previousProcessedFiles = normalized.processedFiles
  const previousByPath = new Map(previousProcessedFiles.map((file) => [file.path, file]))
  const worktreeLookup = await buildWorktreeLookup(worktrees)
  const plans = new Map<string, ClaudeUsageFilePlan>()
  for (let index = 0; index < files.length; index += FILE_SCAN_BATCH_SIZE) {
    const batch = files.slice(index, index + FILE_SCAN_BATCH_SIZE)
    const batchPlans = await Promise.all(
      batch.map((path) => planClaudeUsageFile(path, previousByPath.get(path), normalized.resumable))
    )
    for (const [offset, plan] of batchPlans.entries()) {
      plans.set(batch[offset], plan)
    }
    onFilesScanned?.(batch.length)
    if (index + batch.length < files.length) {
      await yieldToEventLoop()
    }
  }
  const lostOwner = previousProcessedFiles.some(
    (previous) => previous.ownedDedupeKeys?.length > 0 && !plans.has(previous.path)
  )
  let invalidatedCorrections =
    normalized.invalidated ||
    previousProcessedFiles.some(
      (previous) => previous.hasDeferredClaims && !plans.has(previous.path)
    )
  const ownerByKey = new Map<string, string>()
  const projections = new Map<string, ClaudeUsagePersistedFile>()
  for (const path of files) {
    const plan = plans.get(path)!
    const previousKeys = plan.previous?.ownedDedupeKeys
    for (const key of Array.isArray(previousKeys) ? previousKeys : []) {
      if (!ownerByKey.has(key)) {
        ownerByKey.set(key, path)
      }
    }
    if (plan.reusable && plan.previous) {
      projections.set(path, plan.previous)
    }
  }
  const observations = new Map<string, ClaudeUsageParsedSourceTurn[]>()
  const reconcilers = new Map<string, ClaudeUsageTokenReconciler>()
  const rebuiltOwnerPaths = new Set<string>()
  let rebuiltOwner = false
  let lateOwnerLoss = lostOwner
  const publishRead = async (
    path: string,
    read: ClaudeUsageScanFile,
    previous?: ClaudeUsagePersistedFile
  ): Promise<void> => {
    const releasedKeys: string[] = []
    if (!read.resumed) {
      const previousKeys = previous?.ownedDedupeKeys
      for (const key of Array.isArray(previousKeys) ? previousKeys : []) {
        if (ownerByKey.get(key) === path) {
          ownerByKey.delete(key)
          releasedKeys.push(key)
        }
      }
    }
    const projected = await projectClaudeUsageScanFile(
      read,
      worktreeLookup,
      (key) => {
        const owner = ownerByKey.get(key)
        if (owner !== undefined && owner !== path) {
          return false
        }
        ownerByKey.set(key, path)
        return true
      },
      previous,
      (reconcile, retainsPreviousMaxima) => {
        reconcilers.set(path, reconcile)
        // Deferred files can also own keys; replay each rebuilt owner's forks only once.
        if (
          !read.resumed &&
          previous?.ownedDedupeKeys.length &&
          !rebuiltOwnerPaths.has(path) &&
          (previous.hasCrossFileCorrections || !retainsPreviousMaxima)
        ) {
          rebuiltOwnerPaths.add(path)
          rebuiltOwner = true
        }
      }
    )
    observations.set(
      path,
      read.turns.filter((turn) => turn.dedupeKey && ownerByKey.get(turn.dedupeKey) !== path)
    )
    const retainedKeys = new Set(projected.ownedDedupeKeys)
    lateOwnerLoss ||= releasedKeys.some((key) => !retainedKeys.has(key))
    projections.set(path, projected)
  }
  const rebuild = async (path: string): Promise<void> => {
    await publishRead(path, await readClaudeUsageScanFile(path), projections.get(path))
    onFilesScanned?.(1)
  }
  const changed = files.filter((path) => !plans.get(path)?.reusable)
  for (let index = 0; index < changed.length; index += FILE_SCAN_BATCH_SIZE) {
    const batch = changed.slice(index, index + FILE_SCAN_BATCH_SIZE)
    const reads = await Promise.all(
      batch.map((path) => readClaudeUsageScanFile(path, plans.get(path)?.resume))
    )
    for (const [offset, path] of batch.entries()) {
      invalidatedCorrections ||=
        !reads[offset].resumed && plans.get(path)?.previous?.hasDeferredClaims === true
      await publishRead(path, reads[offset], plans.get(path)?.previous)
    }
    onFilesScanned?.(batch.length)
    if (index + batch.length < changed.length) {
      await yieldToEventLoop()
    }
  }
  if (invalidatedCorrections) {
    // A replaced or missing fork can lower maxima; rebuild before replaying surviving forks.
    for (const path of files) {
      const previous = projections.get(path)
      if (previous?.hasCrossFileCorrections) {
        await rebuild(path)
      }
    }
  }
  while (true) {
    let restoredOwner = false
    // Small files and partial tails do not persist per-turn checkpoints.
    for (const turns of observations.values()) {
      for (const turn of turns) {
        const path = turn.dedupeKey ? ownerByKey.get(turn.dedupeKey) : undefined
        const file = path ? projections.get(path) : undefined
        if (path && file && !file.parseResumeState && !reconcilers.has(path)) {
          await rebuild(path)
          restoredOwner = true
        }
      }
    }
    // Rebuilt owners lose corrections from unchanged forks; replay those observations.
    if (rebuiltOwner || lateOwnerLoss) {
      rebuiltOwner = false
      lateOwnerLoss = false
      for (const path of files) {
        const previous = projections.get(path)
        if (previous?.hasDeferredClaims) {
          await rebuild(path)
        }
      }
      continue
    }
    if (!restoredOwner) {
      break
    }
  }
  const corrections = new Map<string, ClaudeUsageParsedSourceTurn[]>()
  for (const turns of observations.values()) {
    for (const turn of turns) {
      const owner = turn.dedupeKey ? ownerByKey.get(turn.dedupeKey) : undefined
      if (owner) {
        const pending = corrections.get(owner) ?? []
        pending.push(turn)
        corrections.set(owner, pending)
      }
    }
  }
  for (const [path, turns] of corrections) {
    let file = projections.get(path)!
    if (!reconcilers.has(path)) {
      // Never mutate a projection still held by the previous scan/cache.
      file = { ...file }
      projections.set(path, file)
      reconcilers.set(path, createClaudeUsageTokenReconciler(file))
    }
    reconcilers.get(path)!(turns)
    await yieldToEventLoop()
  }
  const processedFiles: ClaudeUsagePersistedFile[] = []
  const sessionsById = new Map<string, ClaudeUsageSession>()
  const dailyByKey = new Map<string, ClaudeUsageDailyAggregate>()
  for (const path of files) {
    const processed = projections.get(path)
    if (processed) {
      processedFiles.push(processed)
      mergeClaudeSessions(sessionsById, processed.sessions)
      mergeClaudeDailyAggregates(dailyByKey, processed.dailyAggregates)
    }
  }
  return {
    processedFiles,
    sessions: finalizeClaudeSessions(sessionsById),
    dailyAggregates: [...dailyByKey.values()].sort((a, b) =>
      a.day === b.day ? a.projectLabel.localeCompare(b.projectLabel) : a.day.localeCompare(b.day)
    )
  }
}
