import { open } from 'node:fs/promises'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { createAntigravitySessionResumeState } from './session-scanner-antigravity-parser'
import { parseAgentSessionFile } from './session-scanner-agent-parser'
import { createCodexSessionResumeState } from './session-scanner-codex-parser'
import { createDroidSessionResumeState } from './session-scanner-droid-parser'
import { createMessageGraphSessionResumeState } from './session-scanner-graph-parsers'
import { createClaudeSessionResumeState } from './session-scanner-primary-parsers'
import { createGeminiJsonlSessionResumeState } from './session-scanner-gemini-parsers'
import {
  createCopilotSessionResumeState,
  createCursorSessionResumeState
} from './session-scanner-secondary-parsers'
import { countSubagentTranscripts } from './session-scanner-subagent-transcripts'
import type { ResumableSessionParseState, SessionFileCandidate } from './session-scanner-types'
import { consumeAiVaultJsonlLines } from './session-jsonl-line-reader'
import {
  getSessionParseCacheEntry,
  resetSessionParseCacheRetentionForTests,
  storeSessionParseCacheEntry,
  type SessionParseCacheEntry
} from './session-parse-cache-retention'

export {
  seedSessionParseCache,
  snapshotSessionParseCacheForPersistence,
  type PersistedSessionParseCacheEntry
} from './session-parse-cache-retention'

const NEWLINE_BYTE = 0x0a

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
    case 'omp': {
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
    case 'kimi':
    case 'opencode':
    case 'rovo':
      return null
  }
}

export type SessionParseStats = {
  reused: number
  incremental: number
  fullParses: number
  bytesRead: number
}

export function createSessionParseStats(): SessionParseStats {
  return { reused: 0, incremental: 0, fullParses: 0, bytesRead: 0 }
}

export function resetSessionParseCacheForTests(): void {
  resetSessionParseCacheRetentionForTests()
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
  const { file } = candidate
  const entry = getSessionParseCacheEntry(file.path)

  const unchanged =
    entry !== undefined &&
    entry.platform === platform &&
    entry.mtimeMs === file.mtimeMs &&
    (entry.sizeBytes === null || file.sizeBytes === undefined || entry.sizeBytes === file.sizeBytes)
  if (unchanged) {
    if (stats) {
      stats.reused++
    }
    // A zero-turn transcript usually never changes again, but its sibling
    // subagents/ dir can gain files after the parent's last write (a
    // still-running subagent finishing). The mtime+size key can't see that,
    // so refresh the cheap directory count on reuse.
    if (entry.session && candidate.agent === 'claude' && entry.session.messageCount === 0) {
      const subagentTranscriptCount = await countSubagentTranscripts(file.path)
      if (subagentTranscriptCount !== entry.session.subagentTranscriptCount) {
        entry.session = { ...entry.session, subagentTranscriptCount }
      }
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
      stateFactory
    })
    storeSessionParseCacheEntry(file.path, parsed)
    return parsed.session
  }

  if (stats) {
    stats.fullParses++
    stats.bytesRead += file.sizeBytes ?? 0
  }
  const session = await parseAgentSessionFile(candidate, platform)
  storeSessionParseCacheEntry(file.path, {
    mtimeMs: file.mtimeMs,
    sizeBytes: file.sizeBytes ?? null,
    platform,
    session,
    resume: null
  })
  return session
}

async function parseResumableCandidate(args: {
  candidate: SessionFileCandidate
  platform: NodeJS.Platform
  entry: SessionParseCacheEntry | undefined
  stats?: SessionParseStats
  stateFactory: () => ResumableSessionParseState
}): Promise<SessionParseCacheEntry> {
  const { file } = args.candidate
  const resume = args.entry?.platform === args.platform ? args.entry.resume : null
  const canResume =
    resume !== null &&
    resume !== undefined &&
    typeof file.sizeBytes === 'number' &&
    file.sizeBytes >= resume.byteOffset &&
    (resume.byteOffset === 0 || (await endsWithNewlineAt(file.path, resume.byteOffset)))

  // Clone before consuming: a failed read must not corrupt the cached state,
  // or the next resume would double-count the lines applied before the error.
  const state = canResume ? resume.state.clone() : args.stateFactory()
  const startOffset = canResume ? resume.byteOffset : 0
  if (args.stats) {
    if (canResume) {
      args.stats.incremental++
    } else {
      args.stats.fullParses++
    }
  }

  const readResult = await consumeAiVaultJsonlLines({
    path: file.path,
    start: startOffset,
    onLine: (line) => state.consumeLine(line)
  })
  if (args.stats) {
    args.stats.bytesRead += readResult.bytesRead
  }

  // The stat this scan displays is current even when nothing new was consumed.
  state.touchFile(file)

  // Keep parity with the one-shot parser: a final unterminated line is shown,
  // but stays out of the resumable state so the (possibly still-growing) line
  // is re-read once complete instead of being half-counted.
  let displayState = state
  if (readResult.trailingPartialLine !== null) {
    displayState = state.clone()
    displayState.consumeLine(readResult.trailingPartialLine)
  }

  return {
    mtimeMs: file.mtimeMs,
    sizeBytes: file.sizeBytes ?? null,
    platform: args.platform,
    session: await displayState.finalize(args.platform),
    resume: { state, byteOffset: readResult.consumedThrough }
  }
}

// A resume point is only valid if it still sits just past a line break;
// anything else means the file was rewritten, not appended. Heuristic: a
// grown rewrite keeping '\n' at exactly this byte would slip through, but
// agent transcripts are append-only so that trade is accepted (worst case is
// a stale vault row until the file is next truncated or the app restarts).
async function endsWithNewlineAt(path: string, offset: number): Promise<boolean> {
  const handle = await open(path, 'r')
  try {
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(1), 0, 1, offset - 1)
    return bytesRead === 1 && buffer[0] === NEWLINE_BYTE
  } finally {
    await handle.close()
  }
}
