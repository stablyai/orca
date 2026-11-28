import { setTimeout as delay } from 'node:timers/promises'
import { matchesRexRootIdentity } from './rex-root-identity'
import { readPosixProcessRow } from '../../provider-process/provider-process-row-read'
import {
  collectDescendantRows,
  readProcessTable,
  readProcessTableBeforeDeadline
} from '../../pty/process-retirement/pty-descendant-termination'
import type { ProcessTableRow } from '../../pty/process-retirement/pty-process-table-parser'
import type { RexSessionRecord } from './rex-session-record'
import type { RexRetirement } from './rex-retirement-journal'

type Identity = RexRetirement['identities'][number]

async function table(deadline: number): Promise<ProcessTableRow[]> {
  const remaining = deadline - Date.now()
  if (remaining <= 0) {
    throw new Error('Rex termination evidence deadline')
  }
  const capture = await readProcessTableBeforeDeadline(readProcessTable, Math.min(remaining, 1000))
  if (!capture?.rows.length || Date.now() >= deadline) {
    throw new Error('Rex process census unavailable')
  }
  return capture.rows
}

export async function captureRexRetirement(
  record: RexSessionRecord,
  deadline: number,
  alreadyExited: boolean
): Promise<Identity[]> {
  if (alreadyExited) {
    // A reported exit may precede OS reaping. Never equate a failed read with absence.
    const row = await readPosixProcessRow(record.rootPid, record.rootIdentity?.resolution)
    if (row === 'unverifiable') {
      throw new Error('Rex exited root identity unavailable')
    }
    if (row && (!record.rootIdentity || row.startedAt === record.rootIdentity.startedAt)) {
      const rows = (await table(deadline)).filter((candidate) => candidate.pid === record.rootPid)
      if (rows.length !== 1) {
        throw new Error('Rex exited root census unavailable')
      }
      return [{ pid: rows[0].pid, startedAt: rows[0].startedAt }]
    }
    return []
  }
  if (!(await matchesRexRootIdentity(record))) {
    throw new Error('Rex root start identity unavailable or changed; close refused')
  }
  const rows = await table(deadline)
  const captured = collectDescendantRows(record.rootPid, rows)
  if (!captured.root || !(await matchesRexRootIdentity(record))) {
    throw new Error('Rex root changed during retirement census')
  }
  // Include descendants and members of the anchored root/foreground process groups.
  const root = rows.find((row) => row.pid === record.rootPid)!
  const groups = new Set(
    [root.pgid, root.tpgid].filter((group) => group !== undefined && group > 0)
  )
  const selected = rows.filter(
    (row) =>
      row.pid === root.pid ||
      groups.has(row.pgid) ||
      captured.descendants.some((child) => child.pid === row.pid)
  )
  if (selected.length > 128 || new Set(selected.map((row) => row.pid)).size !== selected.length) {
    throw new Error('Rex retirement census is ambiguous or exceeds limit')
  }
  return selected.map((row) => ({ pid: row.pid, startedAt: row.startedAt }))
}

export function rexRetirementObservation(
  identities: readonly Identity[],
  rows: readonly ProcessTableRow[]
): boolean {
  return identities.every((identity) => {
    const matching = rows.filter((row) => row.pid === identity.pid)
    // Duplicate PID rows are never exit proof; reused PIDs with a different start marker are unrelated.
    return (
      matching.length === 0 ||
      (matching.length === 1 &&
        (matching[0].startedAt !== identity.startedAt || matching[0].zombie === true))
    )
  })
}

/** Read-only postcondition: no speculative signals to OS PIDs. Two fresh scans must agree. */
export async function verifyRexRetirement(
  identities: readonly Identity[],
  deadline: number
): Promise<void> {
  if (!identities.length) {
    return
  }
  let confirmed = 0
  while (Date.now() < deadline) {
    const rows = await table(deadline)
    confirmed = rexRetirementObservation(identities, rows) ? confirmed + 1 : 0
    if (confirmed >= 2) {
      return
    }
    await delay(50)
  }
  throw new Error('Rex termination outcome unknown: process exit not confirmed')
}

export async function assertRexRootRetired(record: RexSessionRecord): Promise<void> {
  const row = await readPosixProcessRow(record.rootPid, record.rootIdentity?.resolution)
  if (
    row === 'unverifiable' ||
    (row && (!record.rootIdentity || row.startedAt === record.rootIdentity.startedAt))
  ) {
    throw new Error('Rex root retirement unverified')
  }
}
