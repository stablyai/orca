import { basename } from 'node:path'
import { readJsonlFileSnapshot, type JsonlFileSnapshot } from '../usage/jsonl-file-snapshot'
import { readJsonlLinesFromOffset } from '../usage/jsonl-line-offsets'
import {
  openJsonlFileReader,
  validateJsonlFileReader,
  jsonlPhysicalFileId
} from '../usage/jsonl-file-checkpoint'
import { attributeCodexUsageEvent } from './codex-usage-event-attribution'
import type { UsageWorktreeResolver } from '../usage/usage-worktree-resolver'
import { parseCodexUsageRecord, type CodexUsageParseContext } from './codex-usage-record-parser'
import { codexUsageAggregation } from './codex-usage-aggregation'
import {
  buildCodexRolloutResumeState,
  resolveCodexRolloutResume
} from './codex-rollout-resume-state'
import type {
  CodexUsageDailyAggregate,
  CodexUsageParseResumeState,
  CodexUsagePersistedFile,
  CodexUsageProcessedFile,
  CodexUsageSession
} from './types'

const { finalizeSessions, mergeSessions, mergeDailyAggregates, sortDailyAggregates } =
  codexUsageAggregation

export type CodexRolloutParseOptions = {
  /** Suffix-only parse for a diverged legacy copied-session bridge. */
  legacySourceSkipBytes?: number
  canClaimEventKey?: (eventKey: string) => boolean
  commitEventKey?: (eventKey: string) => void
  /** Resume point verified by the caller, with the cached projection to extend. */
  resume?: { state: CodexUsageParseResumeState; previous: CodexUsagePersistedFile }
}

export async function getProcessedFileInfo(filePath: string): Promise<CodexUsageProcessedFile> {
  const fileStat = await readJsonlFileSnapshot(filePath)
  return processedFileInfo(filePath, fileStat)
}

function processedFileInfo(filePath: string, fileStat: JsonlFileSnapshot): CodexUsageProcessedFile {
  return {
    path: filePath,
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size,
    ctimeMs: fileStat.ctimeMs,
    physicalFileId: jsonlPhysicalFileId(fileStat)
  }
}

function mergeRolloutProjections(
  previous: CodexUsagePersistedFile,
  appended: { sessions: CodexUsageSession[]; dailyAggregates: CodexUsageDailyAggregate[] }
): { sessions: CodexUsageSession[]; dailyAggregates: CodexUsageDailyAggregate[] } {
  const sessionsById = new Map<string, CodexUsageSession>()
  mergeSessions(sessionsById, previous.sessions)
  mergeSessions(sessionsById, appended.sessions)
  const dailyByKey = new Map<string, CodexUsageDailyAggregate>()
  mergeDailyAggregates(dailyByKey, previous.dailyAggregates)
  mergeDailyAggregates(dailyByKey, appended.dailyAggregates)
  return {
    sessions: finalizeSessions(sessionsById),
    dailyAggregates: sortDailyAggregates(dailyByKey)
  }
}

function createParseContext(
  filePath: string,
  options: CodexRolloutParseOptions
): CodexUsageParseContext {
  const resume = options.resume?.state
  if (resume) {
    return {
      sessionId: resume.sessionId,
      sessionCwd: resume.sessionCwd,
      currentCwd: resume.currentCwd,
      currentModel: resume.currentModel,
      previousTotals: resume.previousTotals,
      totalOnlyBaselinePending: false
    }
  }
  return {
    sessionId: basename(filePath, '.jsonl'),
    sessionCwd: null,
    currentCwd: null,
    currentModel: null,
    previousTotals: null,
    // Why: suffix-only legacy copy parsing lacks the copied prefix context. A
    // leading total-only snapshot is a baseline, not the suffix's billable delta.
    totalOnlyBaselinePending: (options.legacySourceSkipBytes ?? 0) > 0
  }
}

export async function parseCodexUsageFile(
  filePath: string,
  resolveWorktree: UsageWorktreeResolver,
  options: CodexRolloutParseOptions = {}
): Promise<CodexUsagePersistedFile> {
  let parseOptions = options
  for (;;) {
    const reader = await openJsonlFileReader(filePath)
    try {
      // Verification, parsing and checkpointing must all read the same opened file.
      if (
        parseOptions.resume &&
        (await resolveCodexRolloutResume(filePath, parseOptions.resume.previous, reader)) === null
      ) {
        parseOptions = { ...parseOptions, resume: undefined }
        continue
      }

      const legacySourceSkipBytes = parseOptions.legacySourceSkipBytes ?? 0
      const startOffset = parseOptions.resume?.state.parsedBytes ?? legacySourceSkipBytes
      const context = createParseContext(filePath, parseOptions)
      const accumulator = codexUsageAggregation.createAccumulator()
      const ownedEventKeys = new Set<string>()
      let hasDeferredClaims = false
      let parsedBytes = startOffset
      let resumeContext = context
      let partialTailProducedEvent = false

      for await (const { line, endOffset, terminated } of readJsonlLinesFromOffset(
        filePath,
        startOffset,
        reader
      )) {
        if (!terminated) {
          // The next scan rereads this tail, including its context changes.
          resumeContext = { ...context }
        }
        const parsed = parseCodexUsageRecord(line, context)
        if (terminated) {
          parsedBytes = endOffset
        } else if (parsed) {
          partialTailProducedEvent = true
        }
        if (!parsed) {
          continue
        }
        // Deferred records still advance cumulative totals without retaining their copies.
        if (parseOptions.canClaimEventKey && !parseOptions.canClaimEventKey(parsed.eventKey)) {
          hasDeferredClaims = true
          continue
        }
        ownedEventKeys.add(parsed.eventKey)
        const attributed = await attributeCodexUsageEvent(parsed, resolveWorktree)
        if (attributed) {
          accumulator.add(attributed)
        }
      }

      // A counted unterminated row would be counted again from the committed offset.
      const resumeStateSuppressed = partialTailProducedEvent || legacySourceSkipBytes > 0
      const parseResumeState = resumeStateSuppressed
        ? null
        : await buildCodexRolloutResumeState(
            filePath,
            parsedBytes,
            resumeContext,
            parseOptions.resume?.state.headDigest ?? null,
            reader
          )

      if (
        !(await validateJsonlFileReader(reader, parseOptions.resume?.state)) ||
        (parseOptions.resume && !resumeStateSuppressed && parseResumeState === null)
      ) {
        parseOptions = { ...parseOptions, resume: undefined }
        continue
      }

      await reader.handle.close()

      // Discarded reads cannot claim keys that would hide records in another file.
      for (const eventKey of ownedEventKeys) {
        parseOptions.commitEventKey?.(eventKey)
      }

      const processedFile = processedFileInfo(filePath, reader.stats)
      const appended = accumulator.finalize()
      const previous = parseOptions.resume?.previous
      const committedKeys = previous ? new Set(previous.ownedEventKeys) : ownedEventKeys
      if (previous) {
        for (const key of ownedEventKeys) {
          committedKeys.add(key)
        }
      }
      return {
        ...processedFile,
        ...(previous ? mergeRolloutProjections(previous, appended) : appended),
        ownedEventKeys: [...committedKeys],
        hasDeferredClaims: previous?.hasDeferredClaims || hasDeferredClaims,
        parseResumeState
      }
    } finally {
      await reader.handle.close()
    }
  }
}
