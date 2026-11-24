import { open } from 'node:fs/promises'
import { asRecord } from '../../../ai-vault/parsing/session-record-fields'
import { parseJsonObject } from '../../../ai-vault/parsing/session-json-object'
import { extractString } from '../../../../shared/text/trimmed-string'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { readCodexRolloutBytes } from '../../../native-chat/transcript-history/codex/codex-rollout-history-stream'
import { splitTranscriptStreamLines } from '../../../native-chat/transcript-streaming/transcript-stream-lines'

const SESSION_META_MAX_BYTES = 16 * 1024 * 1024
const HEAD_BYTES = 64 * 1024

/**
 * A header's base, cacheable once session metadata (or the first response) was read.
 * 'unreadable': it never will be (no access, or not a rollout Codex can decode either).
 * 'failed': this read failed and a later one may not. 'vanished': gone since it was listed.
 */
export type HeaderBase =
  | { base: string | null; settled: boolean }
  | 'unreadable'
  | 'failed'
  | 'vanished'

const LASTING_READ_ERRORS = new Set(['EACCES', 'EPERM', 'EISDIR'])

// Fields Codex's SessionMeta can't parse without; a header missing one is skipped like Codex does.
const REQUIRED_META_FIELDS = ['session_id', 'id', 'timestamp', 'cwd', 'originator', 'cli_version']

/**
 * What one line settles: a base, no base (a complete header naming none, or the first response),
 * or nothing (read on). Any session_meta naming a base counts, even one Codex would skip: keeping
 * a parent too many loses nothing.
 */
function settleLine(line: string): { base: string | null } | undefined {
  const record = parseJsonObject(line)
  const payload = asRecord(record?.payload)
  if (!payload) {
    return undefined
  }
  if (record?.type === 'session_meta') {
    const base = extractString(asRecord(payload.history_base)?.thread_id)?.toLowerCase()
    if (base) {
      return { base }
    }
    const complete = REQUIRED_META_FIELDS.every((field) => typeof payload[field] === 'string')
    return complete ? { base: null } : undefined
  }
  return record?.type === 'response_item' && typeof payload.type === 'string'
    ? { base: null }
    : undefined
}

/** Like Codex's metadata reader: lines before a header are skipped until a response item. */
async function streamHistoryBase(path: string): Promise<HeaderBase> {
  let completeLines = false
  let trailingComplete = true
  for await (const { line, terminated } of splitTranscriptStreamLines(
    readCodexRolloutBytes(path),
    SESSION_META_MAX_BYTES
  )) {
    const settled = line.trim() ? settleLine(line) : undefined
    if (settled) {
      return { ...settled, settled: true }
    }
    completeLines ||= terminated
    trailingComplete = terminated || !line.trim()
  }
  // Codex writes session_meta first, in one write: finished lines without it never become a fork.
  // A line still being written could be that header, so it settles nothing yet.
  return { base: null, settled: completeLines && trailingComplete }
}

export async function readHistoryBase(path: string): Promise<HeaderBase> {
  try {
    if (!path.endsWith('.zst')) {
      // Most headers fit one read: no stream or line framing for those.
      const handle = await open(path, 'r')
      const head = Buffer.allocUnsafe(HEAD_BYTES)
      const { bytesRead } = await handle.read(head, 0, HEAD_BYTES, 0).finally(() => handle.close())
      const lines = head.subarray(0, bytesRead).toString('utf8').split('\n')
      // The last piece may be cut off by the read: only whole lines settle here.
      for (const line of lines.slice(0, -1)) {
        const settled = line.trim() ? settleLine(line) : undefined
        if (settled) {
          return { ...settled, settled: true }
        }
      }
    }
    return await streamHistoryBase(path)
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return 'vanished'
    }
    const code = error instanceof Error && 'code' in error ? String(error.code) : null
    // A system error with any other code can pass; one without a code is a decode failure.
    return !code || LASTING_READ_ERRORS.has(code) ? 'unreadable' : 'failed'
  }
}
