import type { AiVaultAgent } from '../../shared/ai-vault-types'
import { readTranscriptSlice } from '../native-chat/wsl-transcript-fs-access'
import {
  CLAUDE_CWD_BUCKET_LAYOUT,
  CODEBUDDY_CWD_BUCKET_LAYOUT,
  PI_CWD_BUCKET_LAYOUT,
  type CwdBucketLayout
} from './session-cwd-bucket-layouts'
import type { FileWithMtime } from './session-scanner-types'
import { asRecord } from './session-scanner-record-value'
import { extractString, parseJsonObject } from './session-scanner-values'

type HeadRecord = Record<string, unknown>

/**
 * How Workspace and Project views find a transcript's cwd without a full parse,
 * so an agent's older in-scope sessions are selected before the recency cap.
 * - bucket: the agent keeps one directory per cwd.
 * - head: the cwd sits in the transcript's opening records.
 * - parse: only the (cached) full parse knows it.
 * - none: the agent never records a cwd, so no session can belong to a scope.
 */
export type SessionScopeCwdSource =
  | { kind: 'bucket'; layout: CwdBucketLayout }
  | { kind: 'head'; cwdOf: (record: HeadRecord) => unknown; firstReadBytes?: number }
  | { kind: 'parse' }
  | { kind: 'none' }

const PARSE: SessionScopeCwdSource = { kind: 'parse' }
// Pi-family header: `{"type":"session","cwd":...}`.
const SESSION_HEADER: SessionScopeCwdSource = {
  kind: 'head',
  cwdOf: (record) => (record.type === 'session' ? record.cwd : undefined)
}

// Keyed by every agent, so a new agent cannot list without saying how its scope is found.
export const AI_VAULT_SCOPE_CWD_SOURCES: Record<AiVaultAgent, SessionScopeCwdSource> = {
  claude: { kind: 'bucket', layout: CLAUDE_CWD_BUCKET_LAYOUT },
  pi: { kind: 'bucket', layout: PI_CWD_BUCKET_LAYOUT },
  codebuddy: { kind: 'bucket', layout: CODEBUDDY_CWD_BUCKET_LAYOUT },
  codex: {
    kind: 'head',
    cwdOf: (record) =>
      record.type === 'session_meta' ? asRecord(record.payload)?.cwd : undefined,
    // Its first record carries the base instructions (about 20 KB): one read, not two.
    firstReadBytes: 64 * 1024
  },
  qoder: { kind: 'head', cwdOf: (record) => record.cwd },
  omp: SESSION_HEADER,
  'prime-agent': SESSION_HEADER,
  openclaw: SESSION_HEADER,
  droid: {
    kind: 'head',
    cwdOf: (record) => (record.type === 'session_start' ? record.cwd : undefined)
  },
  // Gemini transcripts carry no cwd at all.
  gemini: { kind: 'none' },
  // Small per-session documents, a cwd recorded mid-file, a sidecar, or a database row.
  hermes: PARSE,
  cursor: PARSE,
  antigravity: PARSE,
  rovo: PARSE,
  copilot: PARSE,
  opencode: PARSE,
  opencode2: PARSE,
  zcode: PARSE,
  grok: PARSE,
  devin: PARSE,
  cline: PARSE,
  kimi: PARSE,
  muse: PARSE,
  jcode: PARSE,
  kiro: PARSE
}

/** Whether a scan with these scope paths walks this agent's files past the recency cap. */
export function scopeWalksAgentFiles(
  agent: AiVaultAgent,
  scopePaths: readonly string[] | undefined
): boolean {
  const kind = AI_VAULT_SCOPE_CWD_SOURCES[agent].kind
  return (scopePaths?.length ?? 0) > 0 && (kind === 'head' || kind === 'parse')
}

const HEAD_READ_BYTES = 8 * 1024
const HEAD_WIDENED_READ_BYTES = 64 * 1024

/**
 * The cwd named by a transcript's opening records, or null when the head does not
 * settle it (no such record, an oversized first line, an unreadable file). Null
 * is "unknown", never "out of scope": the caller falls back to a full parse.
 */
export async function readTranscriptHeadCwd(
  file: FileWithMtime,
  source: { cwdOf: (record: HeadRecord) => unknown; firstReadBytes?: number },
  signal?: AbortSignal
): Promise<string | null> {
  const cached = headCwdCache.get(file.path)
  if (cached && cached.mtimeMs === file.mtimeMs && cached.sizeBytes === file.sizeBytes) {
    return cached.cwd
  }
  const { cwdOf } = source
  let cwd: string | null = null
  const first = source.firstReadBytes ?? HEAD_READ_BYTES
  for (const length of first < HEAD_WIDENED_READ_BYTES ? [first, HEAD_WIDENED_READ_BYTES] : [first]) {
    let head: Buffer
    try {
      head = await readTranscriptSlice(file.path, 0, length, 'scan', signal)
    } catch (error) {
      if (signal?.aborted) {
        throw error
      }
      return null
    }
    const lines = head.toString('utf8').split(/\r?\n/)
    // A slice shorter than asked ended at EOF, so its last line is complete too.
    const complete = head.length < length ? lines : lines.slice(0, -1)
    cwd = firstHeadCwd(complete, cwdOf)
    if (cwd !== null || head.length < length) {
      break
    }
  }
  if (cwd !== null) {
    headCwdCache.set(file.path, {
      mtimeMs: file.mtimeMs,
      sizeBytes: file.sizeBytes,
      cwd: internCwd(cwd)
    })
  }
  return cwd
}

function firstHeadCwd(
  lines: readonly string[],
  cwdOf: (record: HeadRecord) => unknown
): string | null {
  for (const line of lines) {
    const record = parseJsonObject(line)
    const cwd = record ? extractString(cwdOf(record)) : null
    if (cwd) {
      return cwd
    }
  }
  return null
}

// In memory only: a restart re-reads heads, and parsed files answer from the parse cache.
const headCwdCache = new Map<
  string,
  { mtimeMs: number; sizeBytes: number | undefined; cwd: string }
>()
// Thousands of transcripts share a handful of cwds.
const cwdStrings = new Map<string, string>()

function internCwd(cwd: string): string {
  const existing = cwdStrings.get(cwd)
  if (existing !== undefined) {
    return existing
  }
  cwdStrings.set(cwd, cwd)
  return cwd
}

/** Drops cached heads for transcripts the latest scoped scan no longer discovered. */
export function pruneTranscriptHeadCwdCache(discoveredPaths: ReadonlySet<string>): void {
  for (const path of headCwdCache.keys()) {
    if (!discoveredPaths.has(path)) {
      headCwdCache.delete(path)
    }
  }
  const liveCwds = new Set([...headCwdCache.values()].map((entry) => entry.cwd))
  for (const cwd of cwdStrings.keys()) {
    if (!liveCwds.has(cwd)) {
      cwdStrings.delete(cwd)
    }
  }
}

export function resetTranscriptHeadCwdCacheForTests(): void {
  headCwdCache.clear()
  cwdStrings.clear()
}
