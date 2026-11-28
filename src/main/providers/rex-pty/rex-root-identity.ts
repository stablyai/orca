import { readPosixProcessRow } from '../../provider-process/provider-process-row-read'
import type { RexSessionRecord } from './rex-session-record'

export async function readRexRootIdentity(pid: number): Promise<RexSessionRecord['rootIdentity']> {
  const row = await readPosixProcessRow(pid)
  return !row || row === 'unverifiable'
    ? undefined
    : { startedAt: row.startedAt, resolution: row.startResolution }
}

/** A failed or missing read proves neither identity nor death. */
export async function matchesRexRootIdentity(record: RexSessionRecord): Promise<boolean> {
  const identity = record.rootIdentity
  if (!identity) {
    return false
  }
  const row = await readPosixProcessRow(record.rootPid, identity.resolution)
  return (
    !!row &&
    row !== 'unverifiable' &&
    row.startedAt === identity.startedAt &&
    row.startResolution === identity.resolution
  )
}
