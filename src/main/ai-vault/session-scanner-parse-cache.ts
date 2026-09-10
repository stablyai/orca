import type { AiVaultSession } from '../../shared/ai-vault-types'
import { inSessionParseFileLane } from './session-parse-file-lane'
import { createAntigravitySessionResumeState } from './session-scanner-antigravity-parser'
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
import { refreshCachedCodexTitle } from './session-scanner-codex-cached-title'
import {
  getSessionParseCacheEntry,
  storeSessionParseCacheEntry,
  type SessionParseCacheEntry
} from './session-parse-cache-store'
import type { TranscriptMessageSink } from './session-transcript-consumers'
import { sidecarUnchanged } from './session-sidecar-stat'
import {
  enrichSessionFromSidecar,
  sidecarEnrichesWithoutReparse
} from './session-scanner-sidecar-enrichment'
import {
  readResumableTranscript,
  readWholeTranscript,
  type TranscriptReadStats
} from './session-transcript-reader'

export {
  invalidateSessionParseCacheEntry,
  resetSessionParseCacheForTests,
  seedSessionParseCache,
  snapshotSessionParseCacheForPersistence,
  type PersistedSessionParseCacheEntry
} from './session-parse-cache-store'

// Incremental append-parsing applies only to transcripts that are append-only
// JSONL line-folds. Whole-JSON documents (grok/rovo/devin/hermes/gemini-json)
// are rewritten in place, Kimi reads a state doc plus a sibling wire file, and
// OpenCode reads SQLite rows or a doc plus a message dir — those formats keep
// unchanged-file reuse only and re-parse whole when they change.
// Returns a factory (not a state) so steady-state resumes, which clone the
// cached state instead, never pay for a throwaway accumulator.
function resumableStateFactoryFor(
  candidate: SessionFileCandidate
): ((messages: TranscriptMessageSink) => ResumableSessionParseState) | null {
  switch (candidate.agent) {
    case 'claude':
      return (messages) => createClaudeSessionResumeState(candidate.file, messages)
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
    case 'cline':
    case 'kimi':
    case 'opencode':
    case 'rovo':
      return null
  }
}

export type SessionParseStats = TranscriptReadStats & {
  reused: number
}

export function createSessionParseStats(): SessionParseStats {
  return { reused: 0, incremental: 0, fullParses: 0, earlyStopped: 0, bytesRead: 0 }
}

/**
 * The session list's cursor over the transcript reader: it remembers what each
 * file looked like when it was last listed, reuses that work where the file is
 * provably unchanged (mtime+size), and otherwise asks the reader to resume from
 * the last consumed byte or re-read the file whole. This is what keeps the
 * renderer's ~5s forced rescans from re-reading gigabytes of transcripts
 * (STA-1278/STA-1417: main process pegging one core during multi-agent
 * workloads). Other consumers of the reader keep their own equivalent cursor
 * and never consult this one.
 */
export async function parseAgentSessionFileCached(
  candidate: SessionFileCandidate,
  platform: NodeJS.Platform,
  stats?: SessionParseStats
): Promise<AiVaultSession | null> {
  // The whole lookup-read-store sequence runs in the lane: a concurrent parse of
  // the same path shares this entry's resume point and its message channel.
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

  const transcriptUnchanged =
    entry !== undefined &&
    entry.platform === platform &&
    entry.mtimeMs === file.mtimeMs &&
    (entry.sizeBytes === null || file.sizeBytes === undefined || entry.sizeBytes === file.sizeBytes)
  if (transcriptUnchanged) {
    if (sidecarUnchanged(entry.sidecar, file.sidecar)) {
      return reuseCachedSession(candidate, entry, stats)
    }
    // Only the sibling moved. For an agent whose sibling just adds metadata,
    // re-merge it onto the stored fold result; the transcript is not re-read.
    if (sidecarEnrichesWithoutReparse(candidate) && entry.foldSession !== undefined) {
      const enriched = await enrichSessionFromSidecar(candidate, entry.foldSession, platform)
      entry.session = enriched.session
      entry.sidecar = enriched.refused ? 'unknown' : file.sidecar
      storeSessionParseCacheEntry(file.path, entry)
      if (stats) {
        stats.reused++
      }
      return entry.session
    }
  }

  const stateFactory = resumableStateFactoryFor(candidate)
  if (stateFactory) {
    const read = await readResumableTranscript({
      candidate,
      platform,
      resume: entry?.platform === platform ? entry.resume : null,
      stateFactory,
      stats
    })
    const enriched = await enrichSessionFromSidecar(candidate, read.session, platform)
    storeSessionParseCacheEntry(file.path, {
      mtimeMs: file.mtimeMs,
      sizeBytes: file.sizeBytes ?? null,
      platform,
      session: enriched.session,
      // A refused sibling leaves the transcript's own work cached and resumable;
      // only the sibling is recorded as unknown, so the next healthy scan
      // re-merges it without re-reading the transcript.
      sidecar: enriched.refused ? 'unknown' : file.sidecar,
      foldSession: read.session,
      resume: read.resume
    })
    return enriched.session
  }

  const session = await readWholeTranscript({ candidate, platform, stats })
  storeSessionParseCacheEntry(file.path, {
    mtimeMs: file.mtimeMs,
    sizeBytes: file.sizeBytes ?? null,
    platform,
    session,
    // A whole-file parse reads the sibling itself, so a change to it re-parses.
    sidecar: file.sidecar,
    foldSession: session,
    resume: null
  })
  return session
}

async function reuseCachedSession(
  candidate: SessionFileCandidate,
  entry: SessionParseCacheEntry,
  stats?: SessionParseStats
): Promise<AiVaultSession | null> {
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
        ? await countSubagentTranscripts(candidate.file.path)
        : candidate.agent === 'omp'
          ? await countOmpSubagentTranscripts(candidate.file.path)
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
    entry.session = await refreshCachedCodexTitle(candidate, entry.session)
  }
  storeSessionParseCacheEntry(candidate.file.path, entry)
  return entry.session
}
