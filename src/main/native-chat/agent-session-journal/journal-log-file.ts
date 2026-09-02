// On-disk layout for one session's journal.
//
//   <journal dir>/log.jsonl    append-only rows, fsynced before the caller is told the write landed
//   <journal dir>/snapshot.json  folded state at a compaction boundary PLUS the retained tail
//   <journal dir>/blobs/<sha256> bounded-payload remainders
//
// The snapshot carries its own tail so compaction is one atomic write. A crash
// between publishing the snapshot and truncating the log leaves the log a
// superset of the tail, and recovery unions the two by sequence — never a hole.

import { appendFile, mkdir, open, readFile, stat, type FileHandle } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { durableWriteTempPath, renameDurable, writeFileDurable } from '../../durable-file-write'
import {
  AGENT_SESSION_JOURNAL_SCHEMA_VERSION,
  type AgentJournalRenderItem,
  type AgentJournalSubmission
} from '../../../shared/agent-session-journal-types'
import {
  isAdmissibleAgentJournalRenderItem,
  isAdmissibleAgentJournalSubmission
} from '../../../shared/agent-session-journal-schemas'
import { parseJournalRow, serializeJournalRow, type JournalRow } from './journal-row-schema'
import { assertJournalPhysicalCapacity } from './journal-physical-quota'

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
  /** Bounded by compaction retention; used to deduplicate a replayed settlement. */
  appliedSettlementIds?: string[]
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
  /** Distinguishes an absent/empty log from bytes that could not name an epoch. */
  hasBytes: boolean
}

export type JournalSnapshotReadResult =
  | { status: 'missing' }
  | { status: 'valid'; snapshot: JournalSnapshotFile }
  | { status: 'invalid' }
  /** A future schema version: unreadable by this build, not corrupt. The file
   *  stays authoritative in place and the caller degrades to read-only. */
  | { status: 'unreadable' }

const NEWLINE_BYTE = 0x0a

export async function ensureJournalDir(journalDir: string): Promise<void> {
  await mkdir(journalDir, { recursive: true })
}

export async function readJournalSnapshot(journalDir: string): Promise<JournalSnapshotReadResult> {
  try {
    const raw = await readFile(join(journalDir, JOURNAL_SNAPSHOT_FILE), 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    const version = snapshotSchemaVersion(parsed)
    if (version === null) {
      return { status: 'invalid' }
    }
    // Version is classified BEFORE shape validation, matching row admission: a
    // version only advances because bodies changed, so a valid newer snapshot
    // carries kinds this build cannot parse — unreadable, never corruption.
    if (version > AGENT_SESSION_JOURNAL_SCHEMA_VERSION) {
      return { status: 'unreadable' }
    }
    return isJournalSnapshotFile(parsed)
      ? { status: 'valid', snapshot: parsed }
      : { status: 'invalid' }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { status: 'missing' }
    }
    if (error instanceof SyntaxError) {
      return { status: 'invalid' }
    }
    throw error
  }
}

export async function quarantineInvalidJournalSnapshot(
  journalDir: string,
  quota?: { sessionId: string; maxBytes: number }
): Promise<string> {
  // Rename is normally same-filesystem and size-neutral, but admission must
  // happen before retaining evidence so a full journal never creates an
  // unbounded quarantine artifact (or relies on a copy fallback).
  if (quota) {
    const source = join(journalDir, JOURNAL_SNAPSHOT_FILE)
    // Account for the complete source bytes: rename is usually neutral, but a
    // cross-device/filesystem fallback may briefly retain both inodes.
    const sourceBytes = await stat(source)
      .then((info) => info.size)
      .catch((error) => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return 0
        }
        throw error
      })
    await assertJournalPhysicalCapacity({
      journalDir,
      ...quota,
      peakAdditionalBytes: sourceBytes
    })
  }
  const source = join(journalDir, JOURNAL_SNAPSHOT_FILE)
  const target = join(journalDir, `quarantine-snapshot-${Date.now()}-${randomUUID()}.json`)
  await renameDurable(source, target)
  return target
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { rows: [], unreadable: false, malformed: 0, hasBytes: false }
    }
    throw error
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
      return { rows, unreadable, malformed, remainder: raw.slice(offset), hasBytes: raw.length > 0 }
    }
    malformed += 1
    return { rows, unreadable, malformed, remainder: raw.slice(offset), hasBytes: raw.length > 0 }
  }
  return { rows, unreadable, malformed, hasBytes: raw.length > 0 }
}

/** Row admission requires an integer version of at least 1; a snapshot whose
 *  version cannot even be read is malformed, not a schema statement. */
function snapshotSchemaVersion(value: unknown): number | null {
  const snapshot = recordOf(value)
  const version = snapshot?.v
  return typeof version === 'number' && Number.isInteger(version) && version >= 1 ? version : null
}

function isJournalSnapshotFile(value: unknown): value is JournalSnapshotFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false
  }
  const snapshot = value as Record<string, unknown>
  return (
    typeof snapshot.v === 'number' &&
    typeof snapshot.epoch === 'string' &&
    snapshot.epoch.length > 0 &&
    Number.isInteger(snapshot.compactedThrough) &&
    (snapshot.compactedThrough as number) >= 0 &&
    Number.isInteger(snapshot.highestFence) &&
    // Deep discriminated admission: a JSON-valid item with a corrupt nested
    // shape (e.g. a question whose options are null) must land this snapshot
    // in quarantine rather than throw later in projection or prompt render.
    arrayOf(snapshot.items, isAdmissibleAgentJournalRenderItem) &&
    arrayOf(snapshot.submissions, isAdmissibleAgentJournalSubmission) &&
    arrayOf(snapshot.receipts, isReceipt) &&
    arrayOf(snapshot.aliases, isAlias) &&
    // Older snapshots predate tombstones; absence is fine, a non-array is not —
    // seeding iterates this collection, so a JSON-valid wrong shape must land
    // in quarantine rather than throw through startup restoration.
    (snapshot.tombstones === undefined || arrayOf(snapshot.tombstones, isTombstone)) &&
    (snapshot.appliedSettlementIds === undefined ||
      arrayOf(snapshot.appliedSettlementIds, (entry) => typeof entry === 'string')) &&
    arrayOf(snapshot.tail, (row) => parseJournalRow(JSON.stringify(row)).ok)
  )
}

function arrayOf(value: unknown, predicate: (entry: unknown) => boolean): value is unknown[] {
  return Array.isArray(value) && value.every(predicate)
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function isTombstone(value: unknown): boolean {
  const tombstone = recordOf(value)
  return Boolean(
    tombstone && typeof tombstone.itemId === 'string' && Number.isInteger(tombstone.revision)
  )
}

function isReceipt(value: unknown): boolean {
  const receipt = recordOf(value)
  return Boolean(
    receipt &&
    typeof receipt.clientMessageId === 'string' &&
    typeof receipt.providerItemId === 'string' &&
    typeof receipt.epoch === 'string' &&
    typeof receipt.sequence === 'number' &&
    typeof receipt.acceptedAt === 'number'
  )
}

function isAlias(value: unknown): boolean {
  const alias = recordOf(value)
  return Boolean(
    alias && typeof alias.providerItemId === 'string' && typeof alias.itemId === 'string'
  )
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
    await repairJournalLogTail(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
    // The append below creates a missing log.
  }
  const payload = `${rows.map(serializeJournalRow).join('\n')}\n`
  await appendFile(path, payload, 'utf-8')
  const handle = await open(path, 'r+')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  let directory: FileHandle | undefined
  try {
    directory = await open(journalDir, 'r')
    await directory.sync()
  } catch {
    // Directory fsync is unavailable on some platforms (notably Windows).
  } finally {
    // The tolerance above must not leak the descriptor when open succeeded
    // but sync failed — one leaked handle per append adds up fast.
    await directory?.close().catch(() => undefined)
  }
}

/** Repair only a torn final row. The normal append path reads one byte; scanning
 * backward is reserved for the crash-recovery case and never rereads the log. */
async function repairJournalLogTail(path: string): Promise<void> {
  const handle = await open(path, 'r+')
  try {
    const { size } = await handle.stat()
    if (size === 0) {
      return
    }
    const lastByte = Buffer.alloc(1)
    await handle.read(lastByte, 0, 1, size - 1)
    if (lastByte[0] === NEWLINE_BYTE) {
      return
    }

    const scanChunkBytes = 64 * 1024
    let scanEnd = size
    let boundary = -1
    while (scanEnd > 0 && boundary === -1) {
      const scanStart = Math.max(0, scanEnd - scanChunkBytes)
      const chunk = Buffer.alloc(scanEnd - scanStart)
      await handle.read(chunk, 0, chunk.length, scanStart)
      const newline = chunk.lastIndexOf(NEWLINE_BYTE)
      if (newline !== -1) {
        boundary = scanStart + newline
      }
      scanEnd = scanStart
    }

    const lineStart = boundary + 1
    const finalLine = Buffer.alloc(size - lineStart)
    await handle.read(finalLine, 0, finalLine.length, lineStart)
    // A whole row that merely lost its newline is kept; a real fragment goes.
    const complete = parseJournalRow(finalLine.toString('utf-8')).ok
    await (complete ? handle.write('\n', size) : handle.truncate(lineStart))
    await handle.sync()
  } finally {
    await handle.close()
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
