import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import {
  parseDaemonPidFile,
  salvagePidFromCorruptDaemonRecord
} from '../endpoint/identity/daemon-pid-file-parse'
import { hasErrorCode } from '../endpoint/identity/daemon-process-inspection'
import { getDaemonPidPath } from './daemon-spawner'

/** An older-protocol daemon's pid file names a process that still exists (it may be alive). */
export function legacyDaemonProcessMayBeAlive(
  runtimeDir: string,
  protocolVersion: number
): boolean {
  try {
    const parsed = parseDaemonPidFile(
      readFileSync(getDaemonPidPath(runtimeDir, protocolVersion), 'utf8')
    )
    if (!parsed) {
      return false
    }
    process.kill(parsed.pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists under another user; only a missing pid file or ESRCH proves it gone.
    return hasErrorCode(error, 'EPERM')
  }
}

/**
 * The strict, non-blocking form, for callers that read false as "no daemon here": exit proof, and
 * discovery deciding whether a record may be deleted. Only a missing pid file (ENOENT) or a positive
 * pid naming no process (ESRCH) proves the daemon gone; an unreadable record, or one naming no
 * positive pid (even after salvage), may still stand for a live daemon.
 */
export async function legacyDaemonMayStillRun(
  runtimeDir: string,
  protocolVersion: number
): Promise<boolean> {
  try {
    const content = await readFile(getDaemonPidPath(runtimeDir, protocolVersion), 'utf8')
    const pid = parseDaemonPidFile(content)?.pid ?? salvagePidFromCorruptDaemonRecord(content)
    // Signal 0 to zero or a negative pid probes a process group; its ESRCH says nothing about a daemon.
    if (pid === null || !Number.isSafeInteger(pid) || pid <= 0) {
      return true
    }
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ESRCH'))
  }
}
