import { inSessionParseFileLane } from './session-parse-file-lane'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { createAntigravitySessionResumeState } from './session-scanner-antigravity-parser'
import { parseAgentSessionFile } from './session-scanner-agent-parser'
import { createCodexSessionResumeState } from './session-scanner-codex-parser'
import { createDroidSessionResumeState } from './session-scanner-droid-parser'
import { createMessageGraphSessionResumeState } from './session-scanner-graph-parsers'
import { createClaudeSessionResumeState } from './session-scanner-primary-parsers'
import { createGeminiJsonlSessionResumeState } from './session-scanner-gemini-parsers'
import { createCopilotSessionResumeState } from './session-scanner-copilot-parser'
import { createCursorSessionResumeState } from './session-scanner-cursor-parser'
import { countSubagentTranscripts } from './session-scanner-subagent-transcripts'
import { countOmpSubagentTranscripts } from './session-scanner-omp-subagent-transcripts'
import type { ResumableSessionParseState, SessionFileCandidate } from './session-scanner-types'
import { refreshCachedCodexMetadata } from './session-scanner-codex-cached-metadata'
import { consumeCompleteJsonlLines, type JsonlReadResult } from './session-scanner-jsonl-reader'
import { getSessionParseCacheEntry, storeSessionParseCacheEntry } from './session-parse-cache-store'
import {
  endsWithNewlineAt,
  fileIdentity,
  sameFileIdentity,
  type ResumePoint
} from './session-scanner-resume-point'
import {
  getSessionSearchIndexMode,
  getSessionSearchIndexSink,
  withoutSessionSearchCapture,
  withSessionSearchCapture,
  type SessionSearchIndexSink
} from './session-search-capture'

export type SessionParseCacheEntry = {
  mtimeMs: number
  sizeBytes: number | null
  platform: NodeJS.Platform
  session: AiVaultSession | null
  resume: ResumePoint | null
}

// Incremental append-parsing applies only to transcripts that are append-only
// JSONL line-folds. Whole-JSON documents (grok/rovo/devin/hermes/gemini-json)
// are rewritten in place, Kimi reads a state doc plus a sibling wire file, and
// OpenCode reads SQLite rows or a doc plus a message dir — those formats keep
// unchanged-file reuse only and re-parse whole when they change.
// Returns a factory (not a state) so steady-state resumes, which clone the
// cached state instead, never pay for a throwaway accumulator.
function resumableStateFactoryFor(
  candidate: SessionFileCandidate
): (() => ResumableSessionParseState) | null {
  switch (candidate.agent) {
    case 'claude':
      return () => createClaudeSessionResumeState(candidate.file)
    case 'codex':
      return () => createCodexSessionResumeState(candidate.file, candidate.codexHome)
    case 'cursor':
      return () => createCursorSessionResumeState(candidate.file)
    case 'copilot':
      return () => createCopilotSessionResumeState(candidate.file)
    case 'droid':
      return () => createDroidSessionResumeState(candidate.file)
    case 'openclaw':
    case 'pi':
    case 'omp':
    case 'prime-agent': {
      const agent = candidate.agent
      return () => createMessageGraphSessionResumeState(agent, candidate.file)
    }
    case 'gemini':
      return candidate.file.path.endsWith('.jsonl')
        ? () => createGeminiJsonlSessionResumeState(candidate.file)
        : null
    case 'antigravity':
      return () => createAntigravitySessionResumeState(candidate.file)
    case 'devin':
    case 'grok':
    case 'hermes':
    case 'cline':
    case 'kimi':
    case 'opencode':
    case 'rovo':
      return null
  }
}

export {
  invalidateSessionParseCacheEntry,
  resetSessionParseCacheForTests,
  seedSessionParseCache,
  snapshotSessionParseCacheForPersistence,
  type PersistedSessionParseCacheEntry
} from './session-parse-cache-store'

export type SessionParseStats = {
  reused: number
  incremental: number
  fullParses: number
  // Transcripts the parser already excluded (Codex workers), re-listed after a
  // write and dismissed without reading. Counted apart from `incremental` so a
  // scan span still shows how much work the early stop actually removed.
  earlyStopped: number
  bytesRead: number
}

export function createSessionParseStats(): SessionParseStats {
  return { reused: 0, incremental: 0, fullParses: 0, earlyStopped: 0, bytesRead: 0 }
}

/**
 * Parse a session file, reusing prior work where the file is provably
 * unchanged (mtime+size) and, for append-only JSONL transcripts (Claude,
 * Codex, Cursor, Copilot, Droid, OpenClaw/Pi/OMP, Gemini-JSONL), resuming the
 * parse from the last consumed byte when the file only grew. This is what
 * keeps the renderer's ~5s forced rescans from re-reading gigabytes of
 * transcripts (STA-1278/STA-1417: main process pegging one core during
 * multi-agent workloads).
 */
export async function parseAgentSessionFileCached(
  candidate: SessionFileCandidate,
  platform: NodeJS.Platform,
  stats?: SessionParseStats
): Promise<AiVaultSession | null> {
  return inSessionParseFileLane(candidate.file.path, () =>
    parseCachedInLane(candidate, platform, stats)
  )
}

async function parseCachedInLane(
  candidate: SessionFileCandidate,
  platform: NodeJS.Platform,
  stats?: SessionParseStats
): Promise<AiVaultSession | null> {
  const { file } = candidate
  const entry = getSessionParseCacheEntry(file.path)
  const registeredSink = getSessionSearchIndexSink()
  const sink = registeredSink?.acceptsCandidate?.(candidate) === false ? null : registeredSink
  const indexed = sink ? sink.indexedFile(file.path, fileIdentity(file)) : null
  const indexCurrent =
    sink === null ||
    (indexed !== null &&
      indexed.mtimeMs === file.mtimeMs &&
      (indexed.sizeBytes === null ||
        file.sizeBytes === undefined ||
        indexed.sizeBytes === file.sizeBytes))
  // In `required` mode a file the index has not caught up on is never
  // "unchanged"; in `opportunistic` mode it is reused and handed to the backfill.
  const indexRequired = sink !== null && getSessionSearchIndexMode() === 'required'

  const unchanged =
    entry !== undefined &&
    entry.platform === platform &&
    entry.mtimeMs === file.mtimeMs &&
    (entry.sizeBytes === null ||
      file.sizeBytes === undefined ||
      entry.sizeBytes === file.sizeBytes) &&
    (indexCurrent || !indexRequired)
  if (unchanged) {
    if (sink && !indexCurrent) {
      sink.markStale(candidate)
    }
    if (stats) {
      stats.reused++
    }
    // A zero-turn transcript usually never changes again, but its sibling
    // subagent dir (Claude `<session>/subagents/`, OMP's same-named artifact
    // dir) can gain files after the parent's last write (a still-running
    // subagent finishing). The mtime+size key can't see that, so refresh the
    // cheap directory count on reuse.
    if (entry.session && entry.session.messageCount === 0) {
      const subagentTranscriptCount =
        candidate.agent === 'claude'
          ? await countSubagentTranscripts(file.path)
          : candidate.agent === 'omp'
            ? await countOmpSubagentTranscripts(file.path)
            : null
      if (
        subagentTranscriptCount !== null &&
        subagentTranscriptCount !== entry.session.subagentTranscriptCount
      ) {
        entry.session = { ...entry.session, subagentTranscriptCount }
      }
    }
    // Codex titles come from session_index.jsonl, which mtime+size can't see.
    // Remote counterpart: remote-session-scanner.ts's reusedCodexTitleRefresh.
    if (entry.session && candidate.agent === 'codex') {
      entry.session = await refreshCachedCodexMetadata(candidate, entry.session)
      sink?.updateMetadata?.(candidate, entry.session)
    }
    storeSessionParseCacheEntry(file.path, entry)
    return entry.session
  }

  const stateFactory = resumableStateFactoryFor(candidate)
  if (stateFactory) {
    const parsed = await parseResumableCandidate({
      candidate,
      platform,
      entry,
      stats,
      stateFactory,
      sink,
      indexRequired,
      indexedOffset: indexed?.byteOffset ?? null
    })
    storeSessionParseCacheEntry(file.path, parsed)
    return parsed.session
  }

  if (stats) {
    stats.fullParses++
    stats.bytesRead += file.sizeBytes ?? 0
  }
  const session = sink
    ? await indexWholeFileParse(sink, candidate, () => parseAgentSessionFile(candidate, platform))
    : await parseAgentSessionFile(candidate, platform)
  storeSessionParseCacheEntry(file.path, {
    mtimeMs: file.mtimeMs,
    sizeBytes: file.sizeBytes ?? null,
    platform,
    session,
    resume: null
  })
  return session
}

async function indexWholeFileParse(
  sink: SessionSearchIndexSink,
  candidate: SessionFileCandidate,
  parse: () => Promise<AiVaultSession | null>
): Promise<AiVaultSession | null> {
  const captured = await withSessionSearchCapture(parse)
  sink.apply({
    candidate,
    session: captured.value,
    mode: 'replace',
    messages: captured.messages,
    previousByteOffset: 0,
    byteOffset: candidate.file.sizeBytes ?? 0
  })
  return captured.value
}

async function parseResumableCandidate(args: {
  candidate: SessionFileCandidate
  platform: NodeJS.Platform
  entry: SessionParseCacheEntry | undefined
  stats?: SessionParseStats
  stateFactory: () => ResumableSessionParseState
  sink: SessionSearchIndexSink | null
  indexRequired: boolean
  indexedOffset: number | null
}): Promise<SessionParseCacheEntry> {
  const { file } = args.candidate
  const resume = args.entry?.platform === args.platform ? args.entry.resume : null
  const parserCanResume =
    resume !== null &&
    resume !== undefined &&
    typeof file.sizeBytes === 'number' &&
    file.sizeBytes >= resume.byteOffset &&
    sameFileIdentity(resume.identity, fileIdentity(file)) &&
    (resume.byteOffset === 0 || (await endsWithNewlineAt(file.path, resume.byteOffset)))
  // The index can only take an append that continues from its own offset.
  const indexInStep =
    args.sink !== null && parserCanResume && args.indexedOffset === resume.byteOffset
  const canResume = parserCanResume && (indexInStep || !args.indexRequired)
  // Whole-file parses always feed the index (the bytes are read anyway); an
  // append feeds it only when in step, otherwise the backfill re-parses later.
  const feedIndex = args.sink !== null && (!canResume || indexInStep)
  if (args.sink && canResume && !indexInStep) {
    args.sink.markStale(args.candidate)
  }

  // Clone before consuming: a failed read must not corrupt the cached state,
  // or the next resume would double-count the lines applied before the error.
  const state = canResume ? resume.state.clone() : args.stateFactory()
  const startOffset = canResume ? resume.byteOffset : 0
  // Mirrors the reader's entry guard so a dismissed transcript is not reported
  // as an incremental parse that read nothing.
  const stoppedBeforeRead = state.shouldStop?.() === true
  if (args.stats) {
    if (stoppedBeforeRead) {
      args.stats.earlyStopped++
    } else if (canResume) {
      args.stats.incremental++
    } else {
      args.stats.fullParses++
    }
  }

  const read = (): Promise<JsonlReadResult> =>
    consumeCompleteJsonlLines({
      path: file.path,
      start: startOffset,
      onLine: (line) => state.consumeLine(line),
      // Bound: the optional hooks are declared as methods, so a parser written
      // with method syntax must not lose `this` on the way into the reader.
      onLineBytes: state.consumeLineBytes?.bind(state),
      shouldStop: state.shouldStop?.bind(state)
    })
  // Capture only when the index takes these rows: it disables the Codex
  // byte-prefix fast path, which is exactly the cost a list-only scan must not pay.
  const captured = feedIndex
    ? await withSessionSearchCapture(read)
    : { value: await read(), messages: [] }
  const readResult = captured.value
  if (args.stats) {
    args.stats.bytesRead += readResult.bytesRead
  }

  // The stat this scan displays is current even when nothing new was consumed.
  state.touchFile(file)

  // Keep parity with the one-shot parser: a final unterminated line is shown,
  // but stays out of the resumable state so the (possibly still-growing) line
  // is re-read once complete instead of being half-counted. The index only
  // stores complete lines, so the display-only consume must not emit rows.
  let displayState = state
  if (readResult.trailingPartialLine !== null) {
    displayState = state.clone()
    withoutSessionSearchCapture(() => displayState.consumeLine(readResult.trailingPartialLine!))
  }

  const session = await displayState.finalize(args.platform)
  if (feedIndex && args.sink) {
    args.sink.apply({
      candidate: args.candidate,
      // The index stores what the complete lines say; the trailing partial line
      // only changes the displayed session.
      session: displayState === state ? session : await state.finalize(args.platform),
      mode: canResume ? 'append' : 'replace',
      messages: captured.messages,
      previousByteOffset: startOffset,
      byteOffset: readResult.consumedThrough
    })
  }

  return {
    mtimeMs: file.mtimeMs,
    sizeBytes: file.sizeBytes ?? null,
    platform: args.platform,
    session,
    resume: { state, byteOffset: readResult.consumedThrough, identity: fileIdentity(file) }
  }
}
