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

/** { cwd: null } settles absence; null means the read could not settle it. */
export type ScopeCwdRead = { cwd: string | null } | null

/** Scope selection uses cwd buckets, bounded reads, full parses, or no cwd, depending on the agent. */
export type SessionScopeCwdSource =
  | { kind: 'bucket'; layout: CwdBucketLayout }
  | {
      kind: 'read'
      readCwd: (candidate: SessionFileCandidate, signal?: AbortSignal) => Promise<ScopeCwdRead>
    }
  | { kind: 'parse' }
  | { kind: 'none' }

const PARSE: SessionScopeCwdSource = { kind: 'parse' }

/** Opening-record cwd is provisional; a cached full parse takes precedence. */
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

const SESSION_HEADER = head((record) => (record.type === 'session' ? record.cwd : undefined))

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

export const AI_VAULT_SCOPE_CWD_SOURCES: Record<AiVaultAgent, SessionScopeCwdSource> = {
  claude: { kind: 'bucket', layout: CLAUDE_CWD_BUCKET_LAYOUT },
  pi: { kind: 'bucket', layout: PI_CWD_BUCKET_LAYOUT },
  codebuddy: { kind: 'bucket', layout: CODEBUDDY_CWD_BUCKET_LAYOUT },
  // Codex base instructions can enlarge the first record beyond the default read chunk.
  codex: head(
    (record) => (record.type === 'session_meta' ? asRecord(record.payload)?.cwd : undefined),
    64 * 1024
  ),
  qoder: head((record) => record.cwd),
  omp: SESSION_HEADER,
  'prime-agent': SESSION_HEADER,
  openclaw: SESSION_HEADER,
  droid: head((record) => (record.type === 'session_start' ? record.cwd : undefined)),
  gemini: { kind: 'none' },
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

export function scopeWalksAgentFiles(
  agent: AiVaultAgent,
  scopePaths: readonly string[] | undefined
): boolean {
  const kind = AI_VAULT_SCOPE_CWD_SOURCES[agent].kind
  return (scopePaths?.length ?? 0) > 0 && (kind === 'read' || kind === 'parse')
}

const HEAD_READ_BYTES = 8 * 1024
const HEAD_WIDENED_READ_BYTES = 64 * 1024

/** Null means unknown, requiring a full parse; it never proves the transcript is out of scope. */
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
