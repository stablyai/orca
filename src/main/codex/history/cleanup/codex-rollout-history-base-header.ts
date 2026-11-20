import { open } from 'node:fs/promises'
import { asRecord } from '../../../ai-vault/parsing/session-record-fields'
import { parseJsonObject } from '../../../ai-vault/parsing/session-json-object'
import { extractString } from '../../../../shared/text/trimmed-string'
import { isDefinitiveAbsence } from '../../../../shared/errors/definitive-filesystem-absence'
import { readCodexRolloutBytes } from '../../../native-chat/transcript-history/codex/codex-rollout-history-stream'
import { splitTranscriptStreamLines } from '../../../native-chat/transcript-streaming/transcript-stream-lines'

const SESSION_META_MAX_BYTES = 16 * 1024 * 1024
const HEAD_BYTES = 64 * 1024

/** A header's base, cacheable once session metadata (or the first response) was read. */
export type HeaderBase = { base: string | null; settled: boolean } | 'unreadable'

function baseOf(record: Record<string, unknown>): string | null {
  const base = asRecord(asRecord(record.payload)?.history_base)
  return extractString(base?.thread_id)?.toLowerCase() ?? null
}

/** Like Codex's metadata reader: lines before session_meta are skipped until a response item. */
async function streamHistoryBase(path: string): Promise<HeaderBase> {
  let completeLines = false
  for await (const { line, terminated } of splitTranscriptStreamLines(
    readCodexRolloutBytes(path),
    SESSION_META_MAX_BYTES
  )) {
    if (!line.trim()) {
      continue
    }
    const record = parseJsonObject(line)
    if (record?.type === 'session_meta') {
      return { base: baseOf(record), settled: true }
    }
    if (record?.type === 'response_item') {
      return { base: null, settled: true }
    }
    completeLines ||= terminated
  }
  // Codex writes session_meta first, in one write: finished lines without it never become a fork.
  return { base: null, settled: completeLines }
}

export async function readHistoryBase(path: string): Promise<HeaderBase> {
  try {
    if (!path.endsWith('.zst')) {
      // Most headers fit one read: no stream or line framing for those.
      const handle = await open(path, 'r')
      const head = Buffer.allocUnsafe(HEAD_BYTES)
      const { bytesRead } = await handle.read(head, 0, HEAD_BYTES, 0).finally(() => handle.close())
      const end = head.subarray(0, bytesRead).indexOf(10)
      const record = end > 0 ? parseJsonObject(head.subarray(0, end).toString('utf8')) : null
      if (record?.type === 'session_meta') {
        return { base: baseOf(record), settled: true }
      }
    }
    return await streamHistoryBase(path)
  } catch (error) {
    return isDefinitiveAbsence(error) ? { base: null, settled: false } : 'unreadable'
  }
}
