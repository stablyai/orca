import type { AiVaultSession } from '../../shared/ai-vault-types'
import { createAntigravitySessionResumeState } from './session-scanner-antigravity-parser'
import { parseAgentSessionFile } from './session-scanner-agent-parser'
import { createCodexSessionResumeState } from './session-scanner-codex-parser'
import { createTraeSessionResumeState } from './session-scanner-trae-parser'
import { createDroidSessionResumeState } from './session-scanner-droid-parser'
import { createMessageGraphSessionResumeState } from './session-scanner-graph-parsers'
import { consumeCompleteJsonlLines, endsWithNewlineAt } from './session-scanner-jsonl-byte-reader'
import { createClaudeSessionResumeState } from './session-scanner-primary-parsers'
import { createGeminiJsonlSessionResumeState } from './session-scanner-gemini-parsers'
import { createCopilotSessionResumeState } from './session-scanner-copilot-parser'
import { createCursorSessionResumeState } from './session-scanner-cursor-parser'
import { countSubagentTranscripts } from './session-scanner-subagent-transcripts'
import { countOmpSubagentTranscripts } from './session-scanner-omp-subagent-transcripts'
import type {
  ResumableSessionParseState,
  RolloutTitleSource,
  SessionFileCandidate
} from './session-scanner-types'
import { refreshCachedRolloutTitle } from './session-scanner-rollout-cached-title'

// Sized past the default recency cap (1000) plus the in-scope cap (2000) so a
// full steady-state result set stays resident between forced rescans.
const MAX_CACHE_ENTRIES = 4096

type ResumePoint = {
  state: ResumableSessionParseState
  // Byte offset just past the last complete ('\n'-terminated) line consumed;
  // a trailing unterminated line is deliberately left before this point.
  byteOffset: number
}

type SessionParseCacheEntry = {
  mtimeMs: number
  sizeBytes: number | null
  platform: NodeJS.Platform
  session: AiVaultSession | null
  rolloutTitleSource: RolloutTitleSource
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
    case 'trae':
      return () => createTraeSessionResumeState(candidate.file)
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

const cache = new Map<string, SessionParseCacheEntry>()

export function resetSessionParseCacheForTests(): void {
  cache.clear()
}

// Drops one entry after its file is deleted. Cleanliness, not correctness:
// discovery walks disk first, so a trashed file is never rediscovered anyway.
export function invalidateSessionParseCacheEntry(path: string): void {
  cache.delete(path)
}

// Persisted subset of a cache entry: the non-serializable `resume` parser
// state is dropped (see session-parse-cache-persistence.ts).
export type PersistedSessionParseCacheEntry = Omit<SessionParseCacheEntry, 'resume'>

export function snapshotSessionParseCacheForPersistence(): [
  string,
  PersistedSessionParseCacheEntry
][] {
  return [...cache].map(([path, entry]): [string, PersistedSessionParseCacheEntry] => [
    path,
    {
      mtimeMs: entry.mtimeMs,
      sizeBytes: entry.sizeBytes,
      platform: entry.platform,
      session: entry.session,
      rolloutTitleSource: entry.rolloutTitleSource
    }
  ])
}

// Seeded entries carry `resume: null`: after a restart an unchanged file is a
// cache hit; a file that changed while the app was closed pays one full
// (not incremental) re-parse.
export function seedSessionParseCache(
  entries: Iterable<[string, PersistedSessionParseCacheEntry]>
): void {
  const list = [...entries]
  // Snapshot order is oldest→newest (LRU); an over-cap list keeps the newest
  // tail rather than seeding the oldest entries and dropping the tail.
  for (const [path, entry] of list.slice(Math.max(0, list.length - MAX_CACHE_ENTRIES))) {
    if (cache.size >= MAX_CACHE_ENTRIES) {
      return
    }
    // In-process entries are always fresher than persisted ones; never clobber.
    if (cache.has(path)) {
      continue
    }
    cache.set(path, {
      mtimeMs: entry.mtimeMs,
      sizeBytes: entry.sizeBytes,
      platform: entry.platform,
      session: entry.session,
      rolloutTitleSource: entry.rolloutTitleSource,
      resume: null
    })
  }
}

function storeEntry(path: string, entry: SessionParseCacheEntry): void {
  cache.delete(path)
  cache.set(path, entry)
  if (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next()
    if (!oldest.done) {
      cache.delete(oldest.value)
    }
  }
}

/**
 * Parse a session file, reusing prior work where the file is provably
 * unchanged (mtime+size) and, for append-only JSONL transcripts (Claude,
 * Codex/Trae, Cursor, Copilot, Droid, OpenClaw/Pi/OMP, Gemini-JSONL), resuming the
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
  const entry = cache.get(file.path)

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
    if (entry.session && (candidate.agent === 'codex' || candidate.agent === 'trae')) {
      entry.session = await refreshCachedRolloutTitle(
        candidate,
        entry.session,
        entry.rolloutTitleSource
      )
    }
    storeEntry(file.path, entry)
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
    storeEntry(file.path, parsed)
    return parsed.session
  }

  if (stats) {
    stats.fullParses++
    stats.bytesRead += file.sizeBytes ?? 0
  }
  const session = await parseAgentSessionFile(candidate, platform)
  storeEntry(file.path, {
    mtimeMs: file.mtimeMs,
    sizeBytes: file.sizeBytes ?? null,
    platform,
    session,
    rolloutTitleSource: null,
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

  const readResult = await consumeCompleteJsonlLines({
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

  const session = await displayState.finalize(args.platform)
  return {
    mtimeMs: file.mtimeMs,
    sizeBytes: file.sizeBytes ?? null,
    platform: args.platform,
    session,
    rolloutTitleSource: displayState.rolloutTitleSource ?? null,
    resume: { state, byteOffset: readResult.consumedThrough }
  }
}
