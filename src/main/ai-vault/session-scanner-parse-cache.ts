import { createReadStream } from 'node:fs'
import { open } from 'node:fs/promises'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { parseAgentSessionFile } from './session-scanner-agent-parser'
import {
  cloneClaudeSessionParseState,
  consumeClaudeSessionLine,
  createClaudeSessionParseState,
  finalizeClaudeSessionParseState,
  type ClaudeSessionParseState
} from './session-scanner-primary-parsers'
import type { SessionFileCandidate } from './session-scanner-types'

// Sized past the default recency cap (1000) plus the in-scope cap (2000) so a
// full steady-state result set stays resident between forced rescans.
const MAX_CACHE_ENTRIES = 4096

const NEWLINE_BYTE = 0x0a
const CARRIAGE_RETURN_BYTE = 0x0d

type ClaudeResumePoint = {
  state: ClaudeSessionParseState
  // Byte offset just past the last complete ('\n'-terminated) line consumed;
  // a trailing unterminated line is deliberately left before this point.
  byteOffset: number
}

type SessionParseCacheEntry = {
  mtimeMs: number
  sizeBytes: number | null
  platform: NodeJS.Platform
  session: AiVaultSession | null
  claudeResume: ClaudeResumePoint | null
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
 * unchanged (mtime+size) and, for Claude transcripts, resuming the parse from
 * the last consumed byte when the file only grew. This is what keeps the
 * renderer's ~5s forced rescans from re-reading gigabytes of transcripts
 * (STA-1278: main process pegging one core during multi-agent workloads).
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
    storeEntry(file.path, entry)
    return entry.session
  }

  if (candidate.agent === 'claude') {
    const parsed = await parseClaudeCandidateWithResume({ candidate, platform, entry, stats })
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
    claudeResume: null
  })
  return session
}

async function parseClaudeCandidateWithResume(args: {
  candidate: SessionFileCandidate
  platform: NodeJS.Platform
  entry: SessionParseCacheEntry | undefined
  stats?: SessionParseStats
}): Promise<SessionParseCacheEntry> {
  const { file } = args.candidate
  const resume = args.entry?.platform === args.platform ? args.entry.claudeResume : null
  const canResume =
    resume !== null &&
    resume !== undefined &&
    typeof file.sizeBytes === 'number' &&
    file.sizeBytes >= resume.byteOffset &&
    (resume.byteOffset === 0 || (await endsWithNewlineAt(file.path, resume.byteOffset)))

  // Clone before consuming: a failed read must not corrupt the cached state,
  // or the next resume would double-count the lines applied before the error.
  const state = canResume
    ? cloneClaudeSessionParseState(resume.state)
    : createClaudeSessionParseState(file)
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
    onLine: (line) => consumeClaudeSessionLine(state, line)
  })
  if (args.stats) {
    args.stats.bytesRead += readResult.bytesRead
  }

  // The stat this scan displays is current even when nothing new was consumed.
  state.accumulator.modifiedAt = file.modifiedAt

  // Keep parity with the one-shot parser: a final unterminated line is shown,
  // but stays out of the resumable state so the (possibly still-growing) line
  // is re-read once complete instead of being half-counted.
  let displayState = state
  if (readResult.trailingPartialLine !== null) {
    displayState = cloneClaudeSessionParseState(state)
    consumeClaudeSessionLine(displayState, readResult.trailingPartialLine)
  }

  return {
    mtimeMs: file.mtimeMs,
    sizeBytes: file.sizeBytes ?? null,
    platform: args.platform,
    session: finalizeClaudeSessionParseState(displayState, args.platform),
    claudeResume: { state, byteOffset: readResult.consumedThrough }
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

type JsonlReadResult = {
  consumedThrough: number
  trailingPartialLine: string | null
  bytesRead: number
}

// Byte-accurate replacement for readline: offsets must count bytes (not
// UTF-8-decoded characters) so a resumed read starts exactly where the last
// complete line ended.
async function consumeCompleteJsonlLines(args: {
  path: string
  start: number
  onLine: (line: string) => void
}): Promise<JsonlReadResult> {
  let consumedThrough = args.start
  let bytesRead = 0
  let remainder: Buffer | null = null

  const stream = createReadStream(args.path, { start: args.start })
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    bytesRead += chunk.length
    const data = remainder ? Buffer.concat([remainder, chunk]) : chunk
    let lineStart = 0
    let newlineIndex = data.indexOf(NEWLINE_BYTE, lineStart)
    while (newlineIndex !== -1) {
      let lineEnd = newlineIndex
      if (lineEnd > lineStart && data[lineEnd - 1] === CARRIAGE_RETURN_BYTE) {
        lineEnd--
      }
      args.onLine(data.toString('utf-8', lineStart, lineEnd))
      lineStart = newlineIndex + 1
      newlineIndex = data.indexOf(NEWLINE_BYTE, lineStart)
    }
    consumedThrough += lineStart
    // Copy the tail so retaining it doesn't pin the whole chunk buffer.
    remainder = lineStart < data.length ? Buffer.from(data.subarray(lineStart)) : null
  }

  return {
    consumedThrough,
    trailingPartialLine: remainder && remainder.length > 0 ? remainder.toString('utf-8') : null,
    bytesRead
  }
}
