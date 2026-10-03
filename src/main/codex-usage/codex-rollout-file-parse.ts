import { basename } from 'node:path'
import { stat } from 'node:fs/promises'
import { readJsonlLinesFromOffset } from '../usage/jsonl-line-offsets'
import {
  digestUsageEventKey,
  packUsageEventKeyDigests,
  unpackUsageEventKeyDigests
} from '../usage/usage-event-key-digest'
import { attributeCodexUsageEvent } from './codex-usage-event-attribution'
import type { UsageWorktreeResolver } from '../usage/usage-worktree-resolver'
import { parseCodexUsageRecord, type CodexUsageParseContext } from './codex-usage-record-parser'
import { codexUsageAggregation } from './codex-usage-aggregation'
import {
  buildCodexRolloutResumeState,
  resolveCodexRolloutResume
} from './codex-rollout-resume-state'
import type {
  CodexUsageAttributedEvent,
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
  /** Receives the event key's ownership digest, not the raw key. */
  claimEventKey?: (eventKeyDigest: string) => boolean
  /** Resume point verified by the caller, with the cached projection to extend. */
  resume?: { state: CodexUsageParseResumeState; previous: CodexUsagePersistedFile }
}

export async function getProcessedFileInfo(filePath: string): Promise<CodexUsageProcessedFile> {
  const fileStat = await stat(filePath)
  return {
    path: filePath,
    mtimeMs: fileStat.mtimeMs,
    size: fileStat.size
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
  // Why: the caller verified this resume point while walking the directory, and
  // every file discovered or parsed since then has run in between. Re-verify
  // here, against the file about to be read, or a rollout replaced in that gap
  // gets the cached session id, cwd, model and running totals stitched onto an
  // unrelated file's records — and `processedFile` below re-stats to the new
  // size, so the reuse path then freezes the corrupted projection.
  if (
    options.resume &&
    (await resolveCodexRolloutResume(filePath, options.resume.previous)) === null
  ) {
    return parseCodexUsageFile(filePath, resolveWorktree, { ...options, resume: undefined })
  }

  const processedFile = await getProcessedFileInfo(filePath)
  const legacySourceSkipBytes = options.legacySourceSkipBytes ?? 0
  const startOffset = options.resume?.state.parsedBytes ?? legacySourceSkipBytes
  const context = createParseContext(filePath, options)

  const events: CodexUsageAttributedEvent[] = []
  const ownedEventKeyDigests = new Set<string>()
  let hasDeferredClaims = false
  let parsedBytes = startOffset
  // Points at the context as of `parsedBytes`, which excludes a partial tail.
  let resumeContext = context
  let partialTailProducedEvent = false

  for await (const { line, endOffset, terminated } of readJsonlLinesFromOffset(
    filePath,
    startOffset
  )) {
    if (!terminated) {
      // Only the final fragment can be unterminated, and the next scan re-reads
      // it, so its context edits must not leak into the persisted resume point.
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
    // Why: fork/resume rollouts start with a copied prefix of the parent file.
    // Events another file already owns are dropped here, but the record still
    // advanced context.previousTotals above, so later deltas stay correct.
    const eventKeyDigest = digestUsageEventKey(parsed.eventKey)
    if (options.claimEventKey && !options.claimEventKey(eventKeyDigest)) {
      hasDeferredClaims = true
      continue
    }
    ownedEventKeyDigests.add(eventKeyDigest)
    const attributed = await attributeCodexUsageEvent(parsed, resolveWorktree)
    if (attributed) {
      events.push(attributed)
    }
  }

  // A counted-but-unterminated tail would be counted again on resume, and a
  // legacy suffix offset is recomputed per scan, so neither may be resumed. A
  // prefix under the resumable floor is turned away by the builder itself.
  const resumeStateSuppressed = partialTailProducedEvent || legacySourceSkipBytes > 0
  const parseResumeState = resumeStateSuppressed
    ? null
    : await buildCodexRolloutResumeState(
        filePath,
        parsedBytes,
        resumeContext,
        // Already verified against the file at the top of this scan.
        options.resume?.state.headDigest ?? null
      )

  // Why: a resume point only exists past the resumable floor and `parsedBytes`
  // only grows, so the builder's other null — a prefix too short to be worth
  // resuming — is unreachable here and this null means a short read: the file
  // shrank past the prefix this parse merged history for, after the
  // re-verification above and during the read. `processedFile` already re-stat'd
  // to the smaller size, so persisting that pair would let the next scan reuse a
  // pre-truncation total forever. An unterminated tail proves the file still
  // runs past the resume offset, so it cannot be this case.
  if (options.resume && !resumeStateSuppressed && parseResumeState === null) {
    return parseCodexUsageFile(filePath, resolveWorktree, { ...options, resume: undefined })
  }

  const appended = codexUsageAggregation.aggregate(events)
  const previous = options.resume?.previous
  if (!previous) {
    return {
      ...processedFile,
      ...appended,
      ownedEventKeyDigests: packUsageEventKeyDigests(ownedEventKeyDigests),
      hasDeferredClaims,
      parseResumeState
    }
  }
  return {
    ...processedFile,
    ...mergeRolloutProjections(previous, appended),
    ownedEventKeyDigests: packUsageEventKeyDigests(
      new Set([
        ...unpackUsageEventKeyDigests(previous.ownedEventKeyDigests),
        ...ownedEventKeyDigests
      ])
    ),
    hasDeferredClaims: previous.hasDeferredClaims || hasDeferredClaims,
    parseResumeState
  }
}
