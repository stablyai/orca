import type { AiVaultAgent } from '../../shared/ai-vault-types'
import { readTranscriptSlice, wslGatedReadFile } from '../native-chat/wsl-transcript-fs-access'
import {
  CLAUDE_CWD_BUCKET_LAYOUT,
  CODEBUDDY_CWD_BUCKET_LAYOUT,
  PI_CWD_BUCKET_LAYOUT,
  type CwdBucketLayout
} from './session-cwd-bucket-layouts'
import type { FileWithMtime, SessionFileCandidate } from './session-scanner-types'
import { asRecord } from './session-scanner-record-value'
import { extractString, parseJsonObject } from './session-scanner-values'
import { clineManifestCwd } from './session-scanner-cline-parser'
import { cursorChatMetaUnavailable, readCursorChatMeta } from './session-scanner-cursor-chat-meta'
import { rovoSessionCwd } from './session-scanner-graph-parsers'
import { grokSessionCwd } from './session-scanner-grok-parser'
import { listedKiroMetadata } from './session-scanner-kiro-parser'
import { openCodeSessionCwd } from './session-scanner-opencode-parser'

type HeadRecord = Record<string, unknown>

/** A definitive cwd (null: the session has none), or null when the read could not settle it. */
export type ScopeCwdRead = { cwd: string | null } | null

/**
 * How Workspace and Project views find a transcript's cwd without a full parse,
 * so an agent's older in-scope sessions are selected before the recency cap.
 * - bucket: the agent keeps one directory per cwd.
 * - read: a small read settles it. A settled cwd is stored per transcript
 *   version, so later scans read nothing; a parse row always outranks it.
 * - parse: only the (cached) full parse knows it.
 * - none: the agent never records a cwd, so no session can belong to a scope.
 */
export type SessionScopeCwdSource =
  | { kind: 'bucket'; layout: CwdBucketLayout }
  | {
      kind: 'read'
      readCwd: (candidate: SessionFileCandidate, signal?: AbortSignal) => Promise<ScopeCwdRead>
    }
  | { kind: 'parse' }
  | { kind: 'none' }

const PARSE: SessionScopeCwdSource = { kind: 'parse' }

/** The cwd in the transcript's opening records; a later record can still move it, which a parse row then corrects. */
function head(
  cwdOf: (record: HeadRecord) => unknown,
  firstReadBytes?: number
): SessionScopeCwdSource {
  return {
    kind: 'read',
    readCwd: async ({ file }, signal) => {
      const cwd = await readTranscriptHeadCwd(file, { cwdOf, firstReadBytes }, signal)
      return cwd === null ? null : { cwd }
    }
  }
}

function document(cwdOf: (content: string) => string | null): SessionScopeCwdSource {
  return { kind: 'read', readCwd: ({ file }, signal) => readDocumentCwd(file, cwdOf, signal) }
}

/** The parser's own cwd from the small file it reads first; `cwdOf` throwing is the parser's failure too. */
async function readDocumentCwd(
  file: FileWithMtime,
  cwdOf: (content: string) => string | null,
  signal?: AbortSignal
): Promise<ScopeCwdRead> {
  const content = await settledRead(
    () => wslGatedReadFile(file.path, 'utf-8', 'scan', signal),
    signal
  )
  if (content === null) {
    return null
  }
  try {
    return { cwd: cwdOf(content) }
  } catch {
    return null
  }
}

function jsonRecord(content: string): Record<string, unknown> | null {
  return asRecord(JSON.parse(content) as unknown)
}

// Pi-family header: `{"type":"session","cwd":...}`.
const SESSION_HEADER = head((record) => (record.type === 'session' ? record.cwd : undefined))

// Cursor transcripts never record a cwd; the session's comes from its meta.json.
const CURSOR: SessionScopeCwdSource = {
  kind: 'read',
  readCwd: async ({ file }, signal) => {
    const meta = await settledRead(() => readCursorChatMeta(file.path, signal), signal)
    if (meta) {
      return { cwd: meta.cwd }
    }
    return file.sidecar === 'none' && !cursorChatMetaUnavailable(file.path) ? { cwd: null } : null
  }
}

// Keyed by every agent, so a new agent cannot list without saying how its scope is found.
export const AI_VAULT_SCOPE_CWD_SOURCES: Record<AiVaultAgent, SessionScopeCwdSource> = {
  claude: { kind: 'bucket', layout: CLAUDE_CWD_BUCKET_LAYOUT },
  pi: { kind: 'bucket', layout: PI_CWD_BUCKET_LAYOUT },
  codebuddy: { kind: 'bucket', layout: CODEBUDDY_CWD_BUCKET_LAYOUT },
  // Its first record carries the base instructions (about 20 KB): one read, not two.
  codex: head(
    (record) => (record.type === 'session_meta' ? asRecord(record.payload)?.cwd : undefined),
    64 * 1024
  ),
  qoder: head((record) => record.cwd),
  omp: SESSION_HEADER,
  'prime-agent': SESSION_HEADER,
  openclaw: SESSION_HEADER,
  droid: head((record) => (record.type === 'session_start' ? record.cwd : undefined)),
  // Gemini transcripts carry no cwd at all.
  gemini: { kind: 'none' },
  // Their parsers take the cwd from the small file discovery found, before any history.
  grok: document((content) => {
    const summary = jsonRecord(content)
    return summary ? grokSessionCwd(summary) : null
  }),
  rovo: document((content) => {
    const metadata = jsonRecord(content)
    return metadata ? rovoSessionCwd(metadata) : null
  }),
  cline: document(clineManifestCwd),
  kiro: document((content) => {
    const metadata = listedKiroMetadata(content)
    return metadata ? extractString(metadata.cwd) : null
  }),
  cursor: CURSOR,
  // Legacy session files; database rows (`<db>#<id>`) are already filtered by directory in SQL.
  opencode: {
    kind: 'read',
    readCwd: async ({ file }, signal) =>
      file.path.includes('#')
        ? null
        : readDocumentCwd(
            file,
            (content) => {
              const record = jsonRecord(content)
              return record ? openCodeSessionCwd(record) : null
            },
            signal
          )
  },
  // A cwd recorded mid-file, a sidecar join, a shared index, or a database row.
  hermes: PARSE,
  antigravity: PARSE,
  copilot: PARSE,
  opencode2: PARSE,
  zcode: PARSE,
  devin: PARSE,
  kimi: PARSE,
  muse: PARSE,
  jcode: PARSE
}

/** Whether a scan with these scope paths walks this agent's files past the recency cap. */
export function scopeWalksAgentFiles(
  agent: AiVaultAgent,
  scopePaths: readonly string[] | undefined
): boolean {
  const kind = AI_VAULT_SCOPE_CWD_SOURCES[agent].kind
  return (scopePaths?.length ?? 0) > 0 && (kind === 'read' || kind === 'parse')
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
  const { cwdOf } = source
  let cwd: string | null = null
  const first = source.firstReadBytes ?? HEAD_READ_BYTES
  for (const length of first < HEAD_WIDENED_READ_BYTES
    ? [first, HEAD_WIDENED_READ_BYTES]
    : [first]) {
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

/** A read's value, or null when it failed; an abort still propagates. */
async function settledRead<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T | null> {
  try {
    return await read()
  } catch (error) {
    if (signal?.aborted) {
      throw error
    }
    return null
  }
}
