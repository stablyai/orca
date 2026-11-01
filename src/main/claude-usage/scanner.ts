import type {
  ClaudeUsageDailyAggregate,
  ClaudeUsageParseResumeState,
  ClaudeUsagePersistedFile,
  ClaudeUsageSession
} from './types'
import { listClaudeTranscriptFiles } from './transcript-file-discovery'
import {
  createUsageAccountAttribution,
  createUsageAccountRootResolver,
  type UsageAccountRoot
} from '../usage/usage-account-attribution'
import {
  getClaudeUsageProcessedFileStat,
  readClaudeUsageScanFile,
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
  projectClaudeUsageScanFile
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
  resumable: ReadonlySet<ClaudeUsagePersistedFile>,
  reuseProjections: boolean
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
    reuseProjections &&
    validProjection &&
    previous.physicalFileId !== undefined &&
    typeof previous.ctimeMs === 'number' &&
    previous.mtimeMs === fileInfo.mtimeMs &&
    previous.size === fileInfo.size &&
    (previous.ctimeMs === undefined || previous.ctimeMs === fileInfo.ctimeMs) &&
    (!previousId || !fileInfo.physicalFileId || previousId === fileInfo.physicalFileId)
  )
  const resume =
    reuseProjections &&
    !reusable &&
    validProjection &&
    fileInfo.size > previous.size &&
    resumable.has(previous)
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
  verifiedSources?: ClaudeUsageVerifiedSources,
  accountRoots: UsageAccountRoot[] = [],
  reuseProjections = true
): Promise<{
  processedFiles: ClaudeUsagePersistedFile[]
  sessions: ClaudeUsageSession[]
  dailyAggregates: ClaudeUsageDailyAggregate[]
}> {
  const files = await listClaudeTranscriptFiles(profileDirs)
  const normalized = normalizeClaudeUsageSourceFiles(previousProcessedFiles, verifiedSources)
  previousProcessedFiles = normalized.processedFiles
  const previousByPath = new Map(previousProcessedFiles.map((file) => [file.path, file]))
  const accountAttribution = createUsageAccountAttribution(
    previousProcessedFiles.map((file) => ({
      keys: file.ownedDedupeKeys ?? [],
      accountIds: file.ownedAccountIds
    }))
  )
  const resolveAccount = createUsageAccountRootResolver(accountRoots)
  const sourceAccounts = new Map<string, string | null>()
  const worktreeLookup = await buildWorktreeLookup(worktrees)
  const plans = new Map<string, ClaudeUsageFilePlan>()
  for (let index = 0; index < files.length; index += FILE_SCAN_BATCH_SIZE) {
    const batch = files.slice(index, index + FILE_SCAN_BATCH_SIZE)
    const batchPlans = await Promise.all(
      batch.map(async (path) => {
        sourceAccounts.set(path, await resolveAccount(path))
        return planClaudeUsageFile(
          path,
          previousByPath.get(path),
          normalized.resumable,
          reuseProjections
        )
      })
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
      (key) =>
        key
          ? accountAttribution.observe(key, sourceAccounts.get(path) ?? null)
          : previous
            ? null
            : (sourceAccounts.get(path) ?? null)
    )
    const retainedKeys = new Set(projected.ownedDedupeKeys)
    lateOwnerLoss ||= releasedKeys.some((key) => !retainedKeys.has(key))
    projections.set(path, projected)
  }
  const changed = files.filter((path) => !plans.get(path)?.reusable)
  for (let index = 0; index < changed.length; index += FILE_SCAN_BATCH_SIZE) {
    const batch = changed.slice(index, index + FILE_SCAN_BATCH_SIZE)
    const reads = await Promise.all(
      batch.map((path) => readClaudeUsageScanFile(path, plans.get(path)?.resume))
    )
    for (const [offset, path] of batch.entries()) {
      await publishRead(path, reads[offset], plans.get(path)?.previous)
    }
    onFilesScanned?.(batch.length)
    if (index + batch.length < changed.length) {
      await yieldToEventLoop()
    }
  }
  // A planned owner can rotate during its read; previously deferred files must then reclaim.
  while (lateOwnerLoss) {
    lateOwnerLoss = false
    for (const path of files) {
      const previous = projections.get(path)
      if (!previous?.hasDeferredClaims) {
        continue
      }
      await publishRead(path, await readClaudeUsageScanFile(path), previous)
      onFilesScanned?.(1)
    }
  }
  for (const path of files) {
    const current = projections.get(path)
    if (
      current &&
      accountAttribution.needsReprojection({
        keys: current.ownedDedupeKeys,
        accountIds: current.ownedAccountIds
      })
    ) {
      await publishRead(path, await readClaudeUsageScanFile(path), current)
      onFilesScanned?.(1)
    }
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
