// Durable home for payload bytes the live timeline cannot hold.
//
// A row every reconnecting client replays must stay small, so an oversized tool
// result, diff, or assistant message is clipped to a head. The remainder is
// written HERE first, addressed by the sha256 the bound already computes, so the
// clip is a display bound rather than a delete.
//
// Content addressing makes retention idempotent: an item republished at a new
// revision, or two tools returning the same output, retain once. The store lives
// inside the session's journal directory, so removing a session removes its
// payloads with it and nothing has to reference-count them.
//
// The staging-then-rename write and the sha256-named sidecar mirror
// `terminal-scrollback-snapshots.ts`, which stores oversized terminal buffers the
// same way. It bounds each snapshot individually rather than holding a directory
// to a quota, so the eviction below has no counterpart there.
//
// Retention is best effort BY DESIGN. A failed write leaves the row exactly as
// it is bounded today and never worse, because refusing the append instead would
// turn a full disk into a lost turn.
//
// Every call is synchronous because it runs on the main process's append path,
// between translating a provider frame and queueing the row. That is affordable
// only because the directory is never rescanned per write: `directoryBytes`
// caches the running total, so the steady state is one write plus one fsync.
// In-flight stream checkpoints deliberately do not retain (see
// `codex-structured-item-streams.ts`) — retaining a growing payload at every
// checkpoint would write the sum of its prefixes.

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeSync
} from 'node:fs'
import { join } from 'node:path'

const OVERFLOW_DIR_NAME = 'overflow'

/** Per-session budget for retained remainders. Least recently used are evicted
 *  first; the rows keep their head, byte length and digest either way. */
export const JOURNAL_OVERFLOW_QUOTA_BYTES = 64 * 1024 * 1024

/** Where the remainder of a bounded payload goes. `retain` answers whether the
 *  bytes are now durable, which is what the row records as `spilled`. */
export type JournalOverflowSink = {
  retain: (digest: string, payload: string) => boolean
}

/** For bounds whose clipped tail is not the last copy of anything: a derived key
 *  (a prompt option id, a turn ordinal), or an in-flight checkpoint whose text a
 *  later terminal row retains in full. Named so the choice is visible. */
export const JOURNAL_OVERFLOW_NOT_RETAINED: JournalOverflowSink = { retain: () => false }

/** Retained bytes per overflow directory, so a write never rescans it. Rebuilt
 *  by one sweep when the total says the budget may be exceeded, then tracked
 *  through writes and evictions. */
const directoryBytes = new Map<string, number>()

export function journalOverflowDirectory(journalDir: string): string {
  return join(journalDir, OVERFLOW_DIR_NAME)
}

export function journalOverflowFile(journalDir: string, digest: string): string {
  return join(journalOverflowDirectory(journalDir), `${digest}.txt`)
}

/** Retained bytes for a digest, or null when the payload was never retained or
 *  has since been evicted. */
export function readJournalOverflow(journalDir: string, digest: string): string | null {
  try {
    return readFileSync(journalOverflowFile(journalDir, digest), 'utf8')
  } catch {
    return null
  }
}

/** Drops the cached total for a directory. Tests reusing a path need this;
 *  production directories are per session and are never reused. */
export function forgetJournalOverflowDirectory(journalDir: string): void {
  directoryBytes.delete(journalOverflowDirectory(journalDir))
}

export function journalOverflowSink(
  journalDir: string,
  quotaBytes: number = JOURNAL_OVERFLOW_QUOTA_BYTES
): JournalOverflowSink {
  return {
    retain: (digest, payload) => retainJournalOverflow(journalDir, digest, payload, quotaBytes)
  }
}

function retainJournalOverflow(
  journalDir: string,
  digest: string,
  payload: string,
  quotaBytes: number
): boolean {
  const bytes = Buffer.from(payload, 'utf8')
  // A single payload larger than the whole budget would evict everything else
  // to store one item; the row's head, length and digest still describe it.
  if (bytes.byteLength > quotaBytes) {
    return false
  }
  const directory = journalOverflowDirectory(journalDir)
  const file = journalOverflowFile(journalDir, digest)
  try {
    if (existsSync(file)) {
      // Touch it so eviction order is last use, not first write: a payload
      // republished across revisions is the one most worth keeping.
      touchQuietly(file)
      return true
    }
    mkdirSync(directory, { recursive: true })
    evictJournalOverflow(directory, quotaBytes - bytes.byteLength)
    writeOverflowFile(directory, file, digest, bytes)
    directoryBytes.set(directory, (directoryBytes.get(directory) ?? 0) + bytes.byteLength)
    return true
  } catch {
    // The cached total may now describe a directory this write did not change.
    directoryBytes.delete(directory)
    return false
  }
}

function touchQuietly(file: string): void {
  try {
    const now = new Date()
    utimesSync(file, now, now)
  } catch {
    // Eviction order is a preference, not a correctness property.
  }
}

/** Durable before the rename, so a reader never sees a half-written payload
 *  under a digest that claims to describe it. */
function writeOverflowFile(directory: string, file: string, digest: string, bytes: Buffer): void {
  const staging = join(directory, `${digest}.${process.pid}.partial`)
  const handle = openSync(staging, 'w')
  try {
    writeSync(handle, bytes)
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  try {
    renameSync(staging, file)
  } catch (error) {
    rmSync(staging, { force: true })
    throw error
  }
}

/** Least-recently-used first, down to `budget`. Retained payloads are recoverable
 *  evidence, not the timeline: shedding the coldest is how the sidecar stays
 *  bounded. Reads the directory only when the cached total says it must. */
function evictJournalOverflow(directory: string, budget: number): void {
  if ((directoryBytes.get(directory) ?? Number.POSITIVE_INFINITY) <= budget) {
    return
  }
  const entries = sweepJournalOverflow(directory)
  let total = entries.reduce((sum, entry) => sum + entry.bytes, 0)
  if (total <= budget) {
    directoryBytes.set(directory, total)
    return
  }
  entries.sort((a, b) => a.modifiedAt - b.modifiedAt)
  for (const entry of entries) {
    if (total <= budget) {
      break
    }
    try {
      rmSync(entry.path, { force: true })
      total -= entry.bytes
    } catch {
      // Left in place; the next retention pass tries again.
    }
  }
  directoryBytes.set(directory, total)
}

function sweepJournalOverflow(
  directory: string
): { path: string; bytes: number; modifiedAt: number }[] {
  const entries: { path: string; bytes: number; modifiedAt: number }[] = []
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    try {
      const stats = statSync(path)
      if (stats.isFile()) {
        entries.push({ path, bytes: stats.size, modifiedAt: stats.mtimeMs })
      }
    } catch {
      // Raced with another eviction; it is already gone.
    }
  }
  return entries
}
