// Durable home for PTY ownership records, beside the daemon's pid record in the runtime
// directory. Same scope as that file on purpose: one endpoint, one generation of protocol, one
// set of PTYs. A record that outlives its daemon is the whole point — it is read by whichever
// daemon comes next.

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PRIVATE_DIR_MODE, PRIVATE_FILE_MODE, tightenPathMode } from './daemon-private-file-modes'
import {
  asRecordObject,
  parsePtyOwnershipRecord,
  recordKeyOf,
  type PtyOwnershipRecord
} from './pty-ownership-record'
import { PROTOCOL_VERSION } from './types'

const STORE_VERSION = 1

/** Bound on stored rows. Reaching it means records are being written faster than the reconciler
 *  retires them; dropping the oldest keeps the file readable rather than letting one pathological
 *  daemon make every later daemon's read expensive. */
export const MAX_PTY_OWNERSHIP_RECORDS = 512

/** A partial read must never be parsed as "no PTYs were owned" — that is the reading that turns a
 *  disk hiccup into a forgotten leak. */
export type PtyOwnershipRecordRead =
  | { status: 'readable'; records: PtyOwnershipRecord[] }
  | { status: 'unreadable' }

export function getPtyOwnershipRecordPath(
  runtimeDir: string,
  protocolVersion = PROTOCOL_VERSION
): string {
  return join(runtimeDir, `daemon-v${protocolVersion}.pty-owners.json`)
}

function parseStore(text: string): PtyOwnershipRecord[] {
  const rows = asRecordObject(JSON.parse(text))?.records
  if (!Array.isArray(rows)) {
    return []
  }
  // Why per row and not all-or-nothing: one row a newer build wrote must not make this daemon
  // blind to every other owned PTY in the file.
  const records: PtyOwnershipRecord[] = []
  for (const row of rows) {
    const record = parsePtyOwnershipRecord(row)
    if (record) {
      records.push(record)
    }
  }
  return records.slice(-MAX_PTY_OWNERSHIP_RECORDS)
}

function capRecords(records: PtyOwnershipRecord[]): PtyOwnershipRecord[] {
  return records.length > MAX_PTY_OWNERSHIP_RECORDS
    ? records.slice(records.length - MAX_PTY_OWNERSHIP_RECORDS)
    : records
}

/** Matches the local idiom in daemon-pid-identity.ts: only ENOENT proves absence. */
function isMissingFileError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

/** Read-modify-write over one file. Single-writer by construction: only the daemon that owns this
 *  runtime directory's endpoint writes here, and it is one process. */
export class PtyOwnershipRecordStore {
  constructor(private readonly filePath: string) {}

  read(): PtyOwnershipRecordRead {
    let text: string
    try {
      text = readFileSync(this.filePath, 'utf8')
    } catch (error) {
      // A file that was never written is an empty set; anything else is doubt, not emptiness.
      return isMissingFileError(error)
        ? { status: 'readable', records: [] }
        : { status: 'unreadable' }
    }
    try {
      return { status: 'readable', records: parseStore(text) }
    } catch {
      return { status: 'unreadable' }
    }
  }

  upsert(record: PtyOwnershipRecord): void {
    this.upsertMany([record])
  }

  /** Add or replace records in one write. Per-key merge rather than a whole-set replace, so a
   *  writer only has to hold the truth about its own PTYs — no caller reconstructs the others.
   *  `retire` removes existing rows in the same write; it never sees the incoming ones. */
  upsertMany(
    incoming: readonly PtyOwnershipRecord[],
    retire?: (existing: PtyOwnershipRecord) => boolean
  ): void {
    if (incoming.length === 0 && !retire) {
      return
    }
    const byKey = new Map(incoming.map((record) => [recordKeyOf(record), record]))
    this.mutate((records) => {
      const next = records.filter(
        (existing) => !byKey.has(recordKeyOf(existing)) && !retire?.(existing)
      )
      next.push(...byKey.values())
      return capRecords(next)
    })
  }

  /** Add rows whose keys this store does not hold yet, leaving every held row untouched. Returns
   *  whether the write landed, so a caller can tell a merge from a silent failure. */
  insertMissing(incoming: readonly PtyOwnershipRecord[]): boolean {
    return this.mutate((records) => {
      const held = new Set(records.map(recordKeyOf))
      return capRecords([
        ...records,
        ...incoming.filter((record) => !held.has(recordKeyOf(record)))
      ])
    })
  }

  /** Delete the file. Absent already counts as deleted. */
  remove(): boolean {
    try {
      unlinkSync(this.filePath)
      return true
    } catch (error) {
      return isMissingFileError(error)
    }
  }

  /** Replace the records the reconciler re-derived and delete the ones it retired, in one write.
   *  Records it did not mention are kept verbatim: a tick that could not classify a row has not
   *  earned the right to forget it. */
  applyTick(updated: readonly PtyOwnershipRecord[], removedKeys: readonly string[]): void {
    if (updated.length === 0 && removedKeys.length === 0) {
      return
    }
    const removed = new Set(removedKeys)
    const replacements = new Map(updated.map((record) => [recordKeyOf(record), record]))
    this.mutate((records) => {
      const next: PtyOwnershipRecord[] = []
      for (const record of records) {
        const key = recordKeyOf(record)
        if (removed.has(key)) {
          continue
        }
        // Replace in place only. A re-derived record for a key the store no longer holds was
        // retired by something else while this tick ran, and must not be resurrected here.
        next.push(replacements.get(key) ?? record)
      }
      return next
    })
  }

  private mutate(update: (records: PtyOwnershipRecord[]) => PtyOwnershipRecord[]): boolean {
    const current = this.read()
    // Why refuse: rewriting an unreadable file from an empty base would destroy every record it
    // still holds, which is the one failure this store exists to survive.
    if (current.status !== 'readable') {
      return false
    }
    return this.write(update(current.records))
  }

  private write(records: PtyOwnershipRecord[]): boolean {
    const payload = `${JSON.stringify({ version: STORE_VERSION, records })}\n`
    const temporaryPath = `${this.filePath}.tmp`
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: PRIVATE_DIR_MODE })
      // Rename so a daemon killed mid-write leaves the previous record set intact rather than a
      // truncated file that reads as "nothing was owned".
      writeFileSync(temporaryPath, payload, { mode: PRIVATE_FILE_MODE })
      renameSync(temporaryPath, this.filePath)
      tightenPathMode(this.filePath, PRIVATE_FILE_MODE)
      return true
    } catch {
      try {
        unlinkSync(temporaryPath)
      } catch {
        // Nothing to clean up, or the volume is read-only; either way the store is unchanged.
      }
      return false
    }
  }
}
