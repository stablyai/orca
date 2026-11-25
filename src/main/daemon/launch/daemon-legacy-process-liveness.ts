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
 * The strict, non-blocking form, for callers that read false as "no daemon here": exit proof, and
 * discovery deciding whether a record may be deleted. Only a missing pid file (ENOENT) or a whole
 * record's positive pid naming no process (ESRCH) proves the daemon gone; an unreadable or torn
 * record, or one naming no positive pid, may still stand for a live daemon.
 */
export async function legacyDaemonMayStillRun(
  runtimeDir: string,
  protocolVersion: number
): Promise<boolean> {
  try {
    const content = await readFile(getDaemonPidPath(runtimeDir, protocolVersion), 'utf8')
    // Only a whole record proves which process it names: a torn one's integer prefix (of `12.5`, `12e3`,
    // or a cut-off pid) may name another process, whose ESRCH says nothing about this daemon. Nor does
    // signal 0 to zero or a negative pid, which probes a process group.
    const trimmed = content.trim()
    // A bare record proves a pid only as plain digits; `1e3`, `0x10` or a zero-padded token is not one.
    const pid = trimmed.startsWith('{')
      ? (parseDaemonPidFile(trimmed)?.pid ?? null)
      : /^[1-9]\d*$/.test(trimmed)
        ? Number(trimmed)
        : null
    if (pid === null || !Number.isSafeInteger(pid) || pid <= 0) {
      return true
    }
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(hasErrorCode(error, 'ENOENT') || hasErrorCode(error, 'ESRCH'))
  }
}
