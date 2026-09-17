import { canonicalizeUsageWorktreePaths } from '../usage-worktree-canonicalizer'
import {
  canonicalizePath,
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

async function buildWorktreesWithCanonicalPaths(
  worktrees: CodexUsageWorktreeRef[]
): Promise<(CodexUsageWorktreeRef & { canonicalPath: string })[]> {
  return canonicalizeUsageWorktreePaths(worktrees, canonicalizePath)
}

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
  const worktreesWithCanonicalPaths = await buildWorktreesWithCanonicalPaths(worktrees)
  const legacySourceSkipBytesByPath = getLegacySourceSkipBytesByPath(files)

  const currentPaths = new Set(files)
  // Why: when a rollout that owned event keys is deleted, remaining forks still
  // contain those records but their caches record them as unowned. Only files
  // that previously deferred claims can reclaim, so invalidate those — not the
  // entire rollout corpus.
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
    // When an owner disappears, only deferred-claim files need reparse.
    const mustReclaimDeferred = lostOwnerPath && previous?.hasDeferredClaims !== false
    const canReuse =
      !mustReclaimDeferred &&
      legacySourceSkipBytes === 0 &&
      previous &&
      previous.mtimeMs === fileInfo.mtimeMs &&
      previous.size === fileInfo.size &&
      Array.isArray(previous.ownedEventKeys) &&
      typeof previous.hasDeferredClaims === 'boolean'
    if (canReuse) {
      reusedByPath.set(filePath, previous)
    } else {
      // Why: rollouts are append-only and grow all day, so re-reading each one
      // from byte 0 dominated scans (#20940). A reclaim or a legacy suffix
      // offset still needs the whole file, so neither may resume.
      if (!mustReclaimDeferred && legacySourceSkipBytes === 0 && previous) {
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

  // Why: resuming or forking a Codex session copies the parent rollout's
  // token_count records into a new file, so per-file parsing re-counts the
  // whole copied history once per descendant (#8006). Cross-file ownership
  // counts each record for exactly one file; cached and resumed files keep the
  // claims they persisted, and the rest claim in sorted-path order so rescans
  // stay deterministic.
  const eventOwnerByKey = new Map<string, string>()
  for (const filePath of files) {
    const retained = reusedByPath.get(filePath) ?? resumeByPath.get(filePath)?.previous
    for (const eventKey of retained?.ownedEventKeys ?? []) {
      // First retained claim wins so conflicting projections stay deterministic.
      if (!eventOwnerByKey.has(eventKey)) {
        eventOwnerByKey.set(eventKey, filePath)
      }
    }
  }

  const parsedByPath = new Map<string, CodexUsagePersistedFile>()
  for (const [index, filePath] of pathsToParse.entries()) {
    const processed = await parseCodexUsageFile(filePath, worktreesWithCanonicalPaths, {
      legacySourceSkipBytes: legacySourceSkipBytesByPath.get(filePath) ?? 0,
      resume: resumeByPath.get(filePath),
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

    // Why: Codex session history can grow large, and scans run on the Electron
    // main process. Yield regularly so opening Settings does not stall while
    // a background refresh walks old JSONL files.
    onFilesScanned?.(1)
    if ((index + 1) % YIELD_EVERY_FILES === 0) {
      await yieldToEventLoop()
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
