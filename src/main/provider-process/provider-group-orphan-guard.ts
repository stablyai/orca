import { recordSelfInitiatedTreeKill } from '../crash-reporting/process-exits/self-initiated-tree-kill-log'
import { setTimeout as delay } from 'node:timers/promises'
import { hasUnambiguousStartTime } from '../pty/process-retirement/pty-descendant-termination'
import {
  readPosixProcessRow,
  type ProviderProcessRow,
  type ProviderProcessRowReader
} from './provider-process-row-read'

export type ProviderGroupIdentity = {
  pgid: number
  leader: ProviderProcessRow
  watcher: ProviderProcessRow
}

export type ProviderGroupSweepVerdict = 'absent' | 'killed' | 'refused'
export type ProviderGroupGuardDeps = {
  signal?: AbortSignal
  readProcessRow?: ProviderProcessRowReader
  signalGroup?: (pgid: number, signal: NodeJS.Signals | 0) => void
}

/** `absent`: the reader saw no row. `changed`: a reread saw another process or parent. */
export type ProviderProcessIdentityRead = ProviderProcessRow | 'absent' | 'changed' | 'unverifiable'

/** Second-resolution identities are admissible only after a matching reread beyond their start second. */
export async function readProviderProcessIdentity(
  pid: number,
  readRow = readPosixProcessRow
): Promise<ProviderProcessIdentityRead> {
  const capturedAt = Date.now()
  const first = await readRow(pid)
  if (!first || first === 'unverifiable') {
    return first ?? 'absent'
  }
  if (first.startResolution !== 'second' || hasUnambiguousStartTime(first.startedAt, capturedAt)) {
    return first
  }
  await delay(1_050 - (Date.now() % 1_000))
  const rereadAt = Date.now()
  const second = await readRow(pid, first.startResolution)
  if (!second || second === 'unverifiable') {
    return second ?? 'absent'
  }
  if (!sameProviderProcess(first, second) || second.ppid !== first.ppid) {
    return 'changed'
  }
  return hasUnambiguousStartTime(second.startedAt, rereadAt) ? second : 'unverifiable'
}

export async function proveProviderProcessIdentity(
  pid: number,
  readRow = readPosixProcessRow
): Promise<ProviderProcessRow | null> {
  const identity = await readProviderProcessIdentity(pid, readRow)
  return typeof identity === 'object' ? identity : null
}

export function sameProviderProcess(
  expected: ProviderProcessRow,
  actual: ProviderProcessRow
): boolean {
  return (
    expected.pid === actual.pid &&
    expected.startedAt === actual.startedAt &&
    expected.startResolution === actual.startResolution &&
    expected.pgid === actual.pgid
  )
}

export function providerGroupAbsent(pgid: number): boolean {
  try {
    process.kill(-pgid, 0)
    return false
  } catch (error) {
    return isNoProcess(error)
  }
}

/** The sibling watcher reserves the CLI session ID after its leader exits; unreadable or reused identities authorize no kill. */
export async function sweepOrphanedProviderGroup(
  identity: ProviderGroupIdentity,
  deps: ProviderGroupGuardDeps = {}
): Promise<ProviderGroupSweepVerdict> {
  const signal =
    deps.signalGroup ??
    ((pgid, value) => {
      process.kill(-pgid, value)
    })
  try {
    signal(identity.pgid, 0)
  } catch (error) {
    return isNoProcess(error) ? 'absent' : 'refused'
  }
  const read = deps.readProcessRow ?? readPosixProcessRow
  for (const expected of [identity.leader, identity.watcher]) {
    if (deps.signal?.aborted) {
      return 'refused'
    }
    const row = await read(expected.pid, expected.startResolution)
    if (deps.signal?.aborted) {
      return 'refused'
    }
    if (!row || row === 'unverifiable' || !sameProviderProcess(expected, row)) {
      continue
    }
    try {
      signal(identity.pgid, 'SIGKILL')
    } catch (error) {
      return isNoProcess(error) ? 'absent' : 'refused'
    }
    recordSelfInitiatedTreeKill({
      pid: identity.pgid,
      site: 'provider-process-orphan',
      scope: 'posix-process-group'
    })
    return 'killed'
  }
  return 'refused'
}

export function providerOwnershipAbsent(identity: ProviderGroupIdentity): boolean {
  return providerGroupAbsent(identity.pgid) && providerGroupAbsent(identity.watcher.pgid)
}

function isNoProcess(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ESRCH'
}
