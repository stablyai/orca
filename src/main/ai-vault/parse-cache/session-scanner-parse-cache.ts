import {
  throwIfAiVaultScanCancelled,
  waitForAiVaultScan
} from '../scan-lifecycle/ai-vault-scan-cancellation'
import { createQoderSessionResumeState } from '../scanners/qoder/session-scanner-qoder-parser'
import type { AiVaultSession } from '../../../shared/ai-vault/contracts/ai-vault-types'
import { inSessionParseFileLane } from './session-parse-file-lane'
import { createAntigravitySessionResumeState } from '../scanners/antigravity/session-scanner-antigravity-parser'
import { createCodexSessionResumeState } from '../scanners/codex/session-scanner-codex-parser'
import { createDroidSessionResumeState } from '../scanners/droid/session-scanner-droid-parser'
import { createMessageGraphSessionResumeState } from '../scanners/session-scanner-graph-parsers'
import { createClaudeSessionResumeState } from '../scanners/claude/session-scanner-primary-parsers'
import { createCodebuddySessionResumeState } from '../scanners/codebuddy/session-scanner-codebuddy-parser'
import { createGeminiJsonlSessionResumeState } from '../scanners/gemini/session-scanner-gemini-parsers'
import { createCopilotSessionResumeState } from '../scanners/copilot/session-scanner-copilot-parser'
import { createCursorSessionResumeState } from '../scanners/cursor/session-scanner-cursor-parser'
import { countSubagentTranscripts } from '../scanners/claude/session-scanner-subagent-transcripts'
import { countOmpSubagentTranscripts } from '../scanners/omp/session-scanner-omp-subagent-transcripts'
import type { ResumableSessionParseState, SessionFileCandidate } from '../session-scanner-types'
import { refreshCachedCodexTitle } from '../scanners/codex/session-scanner-codex-cached-title'
import {
  getSessionParseCacheEntry,
  noteSessionParseCacheListed,
  sessionParseCacheKey,
  storeSessionParseCacheEntry,
  type SessionParseCacheEntry
} from './session-parse-cache-store'
import type { TranscriptMessageSink } from '../transcripts/session-transcript-consumers'
import { sidecarUnchanged } from './session-sidecar-stat'
import {
  mergeSkippedTranscriptRecords,
  type SkippedTranscriptRecord
} from '../transcripts/session-transcript-record-budget'
import {
  enrichSessionFromSidecar,
  reuseUnchangedSidecarSession,
  sidecarEnrichesWithoutReparse,
  type SidecarEnrichment
} from './session-scanner-sidecar-enrichment'
import {
  readResumableTranscript,
  readWholeTranscript,
  requestWholeTranscriptRead,
  type TranscriptReadStats
} from '../transcripts/session-transcript-reader'

// Resume only append-only folds; return factories so cached resumes avoid allocating throwaway state.
function resumableStateFactoryFor(
  candidate: SessionFileCandidate
): ((messages: TranscriptMessageSink) => ResumableSessionParseState) | null {
  switch (candidate.agent) {
    case 'claude':
      return (messages) => createClaudeSessionResumeState(candidate.file, messages)
    case 'qoder':
      return (messages) => createQoderSessionResumeState(candidate.file, messages)
    case 'codebuddy':
      return (messages) => createCodebuddySessionResumeState(candidate.file, messages)
    case 'codex':
      return (messages) =>
        createCodexSessionResumeState(candidate.file, candidate.codexHome, messages)
    case 'cursor':
      return (messages) => createCursorSessionResumeState(candidate.file, messages)
    case 'copilot':
      return (messages) => createCopilotSessionResumeState(candidate.file, messages)
    case 'droid':
      return (messages) => createDroidSessionResumeState(candidate.file, messages)
    case 'openclaw':
    case 'pi':
    case 'omp':
    case 'prime-agent': {
      const agent = candidate.agent
      return (messages) => createMessageGraphSessionResumeState(agent, candidate.file, messages)
    }
    case 'gemini':
      return candidate.file.path.endsWith('.jsonl')
        ? (messages) => createGeminiJsonlSessionResumeState(candidate.file, messages)
        : null
    case 'antigravity':
      return (messages) => createAntigravitySessionResumeState(candidate.file, messages)
    case 'devin':
    case 'grok':
    case 'hermes':
    case 'jcode':
    case 'cline':
    case 'kimi':
    case 'kiro':
    case 'muse':
    case 'opencode':
    case 'opencode2':
    case 'zcode':
    case 'rovo':
    case 'ante':
      // `meta.json` is rewritten in place, so an append cursor would mix two document versions.
      return null
  }
}

export type SessionParseStats = TranscriptReadStats & {
  reused: number
}

export function createSessionParseStats(): SessionParseStats {
  return {
    reused: 0,
    incremental: 0,
    fullParses: 0,
    earlyStopped: 0,
    bytesRead: 0
  }
}

/** History owns this stat-keyed cursor; transcript consumers track their own read coverage. */
export async function parseAgentSessionFileCached(
  candidate: SessionFileCandidate,
  platform: NodeJS.Platform,
  stats?: SessionParseStats,
  requireRead?: SessionParseReadRequirement,
  signal?: AbortSignal,
  indexing = false
): Promise<AiVaultSession | null> {
  // Serialize lookup/read/store because overlapping parses share a resume point and message channel.
  return inSessionParseFileLane(
    candidate.file.path,
    () => parseCachedInLane(candidate, platform, stats, requireRead, signal, indexing),
    signal
  )
}

/** Mark listed rows before parsing to exempt them from the unlisted cache bound. */
export function parseListedSessionFile(
  candidate: SessionFileCandidate,
  platform: NodeJS.Platform,
  stats: SessionParseStats,
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  noteSessionParseCacheListed(sessionParseCacheKey(candidate.agent, candidate.file.path))
  return parseAgentSessionFileCached(candidate, platform, stats, undefined, signal)
}

/** Enforce in the path lane: any forbids unchanged reuse; whole requires reading from zero. */
export type SessionParseReadRequirement = 'any' | 'whole'

function sessionParseCacheCoversTranscript(
  candidate: SessionFileCandidate,
  key: string,
  platform: NodeJS.Platform
): boolean {
  const { file } = candidate
  const entry = getSessionParseCacheEntry(key)
  return (
    entry !== undefined &&
    entry.platform === platform &&
    entry.mtimeMs === file.mtimeMs &&
    (entry.sizeBytes === null || file.sizeBytes === undefined || entry.sizeBytes === file.sizeBytes)
  )
}

async function parseCachedInLane(
  candidate: SessionFileCandidate,
  platform: NodeJS.Platform,
  stats?: SessionParseStats,
  requireRead?: SessionParseReadRequirement,
  signal?: AbortSignal,
  indexing = false
): Promise<AiVaultSession | null> {
  const { file } = candidate
  const key = sessionParseCacheKey(candidate.agent, file.path)
  const forceWholeRead =
    requireRead === 'whole' ||
    (requireRead === 'any' && sessionParseCacheCoversTranscript(candidate, key, platform))
  if (forceWholeRead) {
    requestWholeTranscriptRead(file.path)
  }
  // Not looked up again after a forced read: a failed database delete would hand the row back.
  const entry = forceWholeRead ? undefined : getSessionParseCacheEntry(key)

  if (entry !== undefined && sessionParseCacheCoversTranscript(candidate, key, platform)) {
    if (sidecarUnchanged(entry.sidecar, file.sidecar)) {
      return reuseCachedSession(candidate, key, entry, stats, signal)
    }
    // Metadata-only sidecar changes can merge onto the saved fold without rereading the transcript.
    if (sidecarEnrichesWithoutReparse(candidate) && entry.foldSession !== undefined) {
      const enriched = await enrichSessionFromSidecar(
        candidate,
        entry.foldSession,
        platform,
        signal
      )
      throwIfAiVaultScanCancelled(signal)
      const session = reuseUnchangedSidecarSession(entry.session, enriched.session)
      storeSessionParseCacheEntry(key, {
        ...entry,
        session,
        sidecar: enriched.refused ? 'unknown' : file.sidecar
      })
      if (stats) {
        stats.reused++
      }
      return session
    }
  }

  let enriched: SidecarEnrichment = { session: null, refused: false }
  const sessionForConsumers = async (
    session: AiVaultSession | null
  ): Promise<AiVaultSession | null> => {
    enriched = await enrichSessionFromSidecar(candidate, session, platform, signal)
    return enriched.session
  }
  const stateFactory = resumableStateFactoryFor(candidate)
  if (stateFactory) {
    const read = await readResumableTranscript({
      candidate,
      platform,
      resume: entry?.platform === platform ? entry.resume : null,
      stateFactory,
      stats,
      signal,
      sessionForConsumers,
      indexing
    })
    storeSessionParseCacheEntry(key, {
      agent: candidate.agent,
      mtimeMs: file.mtimeMs,
      sizeBytes: file.sizeBytes ?? null,
      platform,
      session: enriched.session,
      // Preserve transcript work while refused sidecars stay unknown for a metadata-only retry.
      sidecar: enriched.refused ? 'unknown' : file.sidecar,
      foldSession: read.session,
      resume: read.resume
    })
    return enriched.session
  }

  let skippedRecords: SkippedTranscriptRecord[] = []
  const session = await readWholeTranscript({
    candidate,
    platform,
    stats,
    signal,
    sessionForConsumers,
    indexing,
    onSkippedRecords: (records) => {
      skippedRecords = mergeSkippedTranscriptRecords([], records)
    }
  })
  storeSessionParseCacheEntry(key, {
    agent: candidate.agent,
    mtimeMs: file.mtimeMs,
    sizeBytes: file.sizeBytes ?? null,
    platform,
    session: enriched.session,
    sidecar: enriched.refused ? 'unknown' : file.sidecar,
    foldSession: session,
    resume: null,
    skippedRecords
  })
  return enriched.session
}

async function reuseCachedSession(
  candidate: SessionFileCandidate,
  key: string,
  entry: SessionParseCacheEntry,
  stats?: SessionParseStats,
  signal?: AbortSignal
): Promise<AiVaultSession | null> {
  if (stats) {
    stats.reused++
  }
  let session = entry.session
  // Zero-turn parents may never change again; recount late subagent transcripts outside the cached file signature.
  if (session && session.messageCount === 0) {
    const subagentTranscriptCount =
      session.agent === 'claude'
        ? await countSubagentTranscripts(candidate.file.path, signal)
        : session.agent === 'omp'
          ? await countOmpSubagentTranscripts(candidate.file.path, signal)
          : null
    if (
      subagentTranscriptCount !== null &&
      subagentTranscriptCount !== session.subagentTranscriptCount
    ) {
      session = { ...session, subagentTranscriptCount }
    }
  }
  // Index titles can change independently of the transcript signature.
  if (session && candidate.agent === 'codex') {
    session = await waitForAiVaultScan(refreshCachedCodexTitle(candidate, session), signal)
  }
  throwIfAiVaultScanCancelled(signal)
  storeSessionParseCacheEntry(key, { ...entry, session })
  return session
}
