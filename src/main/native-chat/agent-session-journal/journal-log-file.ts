// On-disk layout for one session's journal.
//
//   <journal dir>/log.jsonl    append-only rows, fsynced before the caller is told the write landed
//   <journal dir>/snapshot.json  folded state at a compaction boundary PLUS the retained tail
//   <journal dir>/blobs/<sha256> bounded-payload remainders
//
// The snapshot carries its own tail so compaction is one atomic write. A crash
// between publishing the snapshot and truncating the log leaves the log a
// superset of the tail, and recovery unions the two by sequence — never a hole.

import { appendFile, mkdir, open, readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { durableWriteTempPath, writeFileDurable } from '../../durable-file-write'
import type {
  AgentJournalRenderItem,
  AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import { parseJournalRow, serializeJournalRow, type JournalRow } from './journal-row-schema'

export const JOURNAL_LOG_FILE = 'log.jsonl'
export const JOURNAL_SNAPSHOT_FILE = 'snapshot.json'

export type JournalSnapshotFile = {
  v: number
  epoch: string
  /** Highest sequence folded into `items`; the tail starts after it. */
  compactedThrough: number
  /** Fence monotonicity survives compaction and restart. */
  highestFence: number
  items: AgentJournalRenderItem[]
  submissions: AgentJournalSubmission[]
  /** Receipts outlive the rows that minted them: a client reconnecting after
   *  compaction must still get the same answer instead of re-sending. */
  receipts: {
    clientMessageId: string
    providerItemId: string
    epoch: string
    sequence: number
    acceptedAt: number
  }[]
  /** Provider item id → submission slot, preserved so a post-compaction echo
   *  still reconciles into the bubble it belongs to. */
  aliases: { providerItemId: string; itemId: string }[]
  tombstones: { itemId: string; revision: number }[]
  tail: JournalRow[]
}

export type JournalReadResult = {
  rows: JournalRow[]
  /** True when a line used a schema version this build cannot read. Reading
   *  STOPS there — the row must not be skipped — and the host degrades to
   *  read-only: no writes, no compaction, no deletion. */
  unreadable: boolean
  /** Lines that failed to parse for reasons other than schema version. */
  malformed: number
  /** Raw suffix beginning at the first malformed line, if any. */
  remainder?: string
}

const NEWLINE_BYTE = 0x0a

export async function ensureJournalDir(journalDir: string): Promise<void> {
  await mkdir(journalDir, { recursive: true })
}

export async function readJournalSnapshotFile(
  journalDir: string
): Promise<JournalSnapshotFile | null> {
  try {
    const raw = await readFile(join(journalDir, JOURNAL_SNAPSHOT_FILE), 'utf-8')
    const parsed = JSON.parse(raw) as JournalSnapshotFile
    return typeof parsed?.epoch === 'string' ? parsed : null
  } catch {
    return null
  }
}

export async function writeJournalSnapshotFile(
  journalDir: string,
  snapshot: JournalSnapshotFile
): Promise<void> {
  const target = join(journalDir, JOURNAL_SNAPSHOT_FILE)
  await writeFileDurable(durableWriteTempPath(target), target, JSON.stringify(snapshot))
}

export async function readJournalLog(journalDir: string): Promise<JournalReadResult> {
  let raw: string
  try {
    raw = await readFile(join(journalDir, JOURNAL_LOG_FILE), 'utf-8')
  } catch {
    return { rows: [], unreadable: false, malformed: 0 }
  }
  const rows: JournalRow[] = []
  let unreadable = false
  let malformed = 0
  const lines = raw.split('\n')
  let offset = 0
  for (const line of lines) {
    if (!line.trim()) {
      offset += line.length + 1
      continue
    }
    const parsed = parseJournalRow(line)
    if (parsed.ok) {
      rows.push(parsed.row)
      offset += line.length + 1
      continue
    }
    if (parsed.unreadable) {
      unreadable = true
      break
    }
    malformed += 1
    return { rows, unreadable, malformed, remainder: raw.slice(offset) }
  }
  return { rows, unreadable, malformed }
}

/**
 * Append rows and fsync before returning. The caller treats a resolved promise
 * as "this row survives a power loss" — the write-ahead submission row depends
 * on exactly that, so this must never be relaxed to a buffered write.
 */
export async function appendJournalRows(
  journalDir: string,
  rows: readonly JournalRow[]
): Promise<void> {
  if (rows.length === 0) {
    return
  }
  const path = join(journalDir, JOURNAL_LOG_FILE)
  // A process death can leave a final JSON fragment without its newline. Never
  // concatenate a new durable row onto that fragment: truncate the torn tail
  // first, then fsync the repair before acknowledging this append.
  try {
    // Read as bytes, not text: `truncate`/`write` take byte offsets, and a
    // transcript's multi-byte characters make string indices the wrong unit.
    const existing = await readFile(path)
    if (existing.length > 0 && existing.at(-1) !== NEWLINE_BYTE) {
      const boundary = existing.lastIndexOf(NEWLINE_BYTE)
      const finalLine = existing.subarray(boundary + 1).toString('utf-8')
      // A whole row that merely lost its newline is kept; a real fragment goes.
      const complete = parseJournalRow(finalLine).ok
      const handle = await open(path, 'r+')
      try {
        await (complete ? handle.write('\n', existing.length) : handle.truncate(boundary + 1))
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
  } catch {
    // The append below creates a missing log; other read errors remain visible.
  }
  const payload = `${rows.map(serializeJournalRow).join('\n')}\n`
  await appendFile(path, payload, 'utf-8')
  const handle = await open(path, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    const directory = await open(journalDir, 'r')
    await directory.sync()
    await directory.close()
  } catch {
    // Directory fsync is unavailable on some platforms (notably Windows).
  }
}

export async function quarantineJournalRemainder(
  journalDir: string,
  remainder: string
): Promise<string> {
  const path = join(journalDir, `quarantine-${Date.now()}-${randomUUID()}.jsonl`)
  await writeFileDurable(durableWriteTempPath(path), path, remainder)
  return path
}

/** Replace the log with exactly the retained tail. Runs only after the snapshot
 *  carrying that tail is durable, so a crash here loses nothing. */
export async function rewriteJournalLog(
  journalDir: string,
  rows: readonly JournalRow[]
): Promise<void> {
  const target = join(journalDir, JOURNAL_LOG_FILE)
  const payload = rows.length ? `${rows.map(serializeJournalRow).join('\n')}\n` : ''
  await writeFileDurable(durableWriteTempPath(target), target, payload)
}
