import { readFileSync } from 'node:fs'
import {
  parseDaemonPidFile,
  type ParsedDaemonPid
} from '../endpoint/identity/daemon-pid-file-parse'
import {
  hasErrorCode,
  inspectProcessLiveness
} from '../endpoint/identity/daemon-process-inspection'
import { getDaemonPidPath } from './daemon-spawner'

export type LegacyDaemonRecordVerdict =
  | { status: 'absent' }
  | { status: 'exited'; record: ParsedDaemonPid }
  | { status: 'live' }
  // A torn record names no process, so only its endpoint can prove the owner gone.
  | { status: 'malformed' }
  | { status: 'unverifiable'; reason: string }

/** Only a missing record or ESRCH for the recorded PID proves an older-protocol daemon gone. */
export function inspectLegacyDaemonRecord(
  runtimeDir: string,
  protocolVersion: number
): LegacyDaemonRecordVerdict {
  let contents: string
  try {
    contents = readFileSync(getDaemonPidPath(runtimeDir, protocolVersion), 'utf8')
  } catch (error) {
    return hasErrorCode(error, 'ENOENT')
      ? { status: 'absent' }
      : { status: 'unverifiable', reason: 'the pid record could not be read' }
  }
  const record = parseDaemonPidFile(contents)
  if (!record) {
    return { status: 'malformed' }
  }
  const liveness = inspectProcessLiveness(record.pid)
  return liveness.status === 'exited' ? { status: 'exited', record } : liveness
}

/** An older-protocol daemon's pid record does not prove its process gone. */
export function legacyDaemonProcessMayBeAlive(
  runtimeDir: string,
  protocolVersion: number
): boolean {
  const verdict = inspectLegacyDaemonRecord(runtimeDir, protocolVersion)
  return verdict.status !== 'absent' && verdict.status !== 'exited'
}
