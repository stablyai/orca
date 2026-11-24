import { readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { parseDaemonPidFile } from '../endpoint/identity/daemon-pid-file-parse'
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
 * Exit proof's stricter, non-blocking form: it reads false as "no daemon here", so only a missing pid
 * file (ENOENT) or a missing process (ESRCH) proves the daemon gone. An unreadable or unparsable record
 * may still name a live daemon. (The sync form stays lenient: discovery deletes such records.)
 */
export async function legacyDaemonMayStillRun(
  runtimeDir: string,
  protocolVersion: number
): Promise<boolean> {
  try {
    const parsed = parseDaemonPidFile(
      await readFile(getDaemonPidPath(runtimeDir, protocolVersion), 'utf8')
    )
    if (!parsed) {
      return true
    }
    process.kill(parsed.pid, 0)
    return true
  } catch (error) {
    return !(hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ESRCH'))
  }
}
