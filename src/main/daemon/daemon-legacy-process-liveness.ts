import { readFileSync } from 'node:fs'
import { parseDaemonPidFile } from './daemon-pid-file-parse'
import { hasErrorCode } from './daemon-process-inspection'
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
