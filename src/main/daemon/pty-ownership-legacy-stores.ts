// Ownership files written under another protocol version.
//
// The store is scoped to one protocol version like the pid record beside it, so an update that
// bumps the protocol leaves the previous daemon's file where no later daemon would ever look. Once
// every daemon that wrote such a file is gone, its records are merged into the current store —
// keeping their own `recordedAt`, so the usual expiry still bounds them — and the file is deleted.

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ProcessTableRow } from '../pty-process-table-parser'
import { owningDaemonStillAlive } from './daemon-orphan-reap-plan'
import { PtyOwnershipRecordStore } from './pty-ownership-record-store'

const OWNERSHIP_FILE_PATTERN = /^daemon-v(\d+)\.pty-owners\.json$/

/** Ownership files in the runtime directory other than the current version's. */
export function listLegacyPtyOwnershipStorePaths(
  runtimeDir: string,
  currentProtocolVersion: number
): string[] {
  let names: string[]
  try {
    names = readdirSync(runtimeDir)
  } catch {
    return []
  }
  return names
    .filter((name) => {
      const match = name.match(OWNERSHIP_FILE_PATTERN)
      return match !== null && Number(match[1]) !== currentProtocolVersion
    })
    .map((name) => join(runtimeDir, name))
}

export type AdoptLegacyStoresInput = {
  paths: readonly string[]
  into: PtyOwnershipRecordStore
  table: readonly ProcessTableRow[]
  selfPid: number
  daemonStartToleranceMs: number
  nowMs: number
  /** An unreadable file older than this is deleted: nothing it holds could still be acted on. */
  maxRecordAgeMs: number
  log: (event: string, details?: Record<string, unknown>) => void
}

/** Returns how many files were settled, so the caller knows whether to re-read its own store. */
export function adoptLegacyPtyOwnershipStores(input: AdoptLegacyStoresInput): number {
  const byPid = new Map<number, ProcessTableRow>()
  for (const row of input.table) {
    if (!byPid.has(row.pid)) {
      byPid.set(row.pid, row)
    }
  }
  let settled = 0
  for (const path of input.paths) {
    const legacy = new PtyOwnershipRecordStore(path)
    const read = legacy.read()
    if (read.status !== 'readable') {
      if (isOlderThan(path, input.nowMs - input.maxRecordAgeMs) && legacy.remove()) {
        input.log('pty-orphan-legacy-records-expired', { path })
        settled += 1
      }
      continue
    }
    const ownerAlive = read.records.some((record) =>
      owningDaemonStillAlive(record, byPid, input.selfPid, input.daemonStartToleranceMs)
    )
    if (ownerAlive) {
      // That daemon is still this file's single writer; it is adopted once the daemon is gone.
      continue
    }
    // Delete only after the merge landed, so a failed write retries instead of losing the rows.
    if ((read.records.length === 0 || input.into.insertMissing(read.records)) && legacy.remove()) {
      input.log('pty-orphan-legacy-records-adopted', { path, records: read.records.length })
      settled += 1
    }
  }
  return settled
}

function isOlderThan(path: string, cutoffMs: number): boolean {
  try {
    return statSync(path).mtimeMs < cutoffMs
  } catch {
    return false
  }
}
