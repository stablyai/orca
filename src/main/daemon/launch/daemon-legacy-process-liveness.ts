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
    return pidFileNamesExistingProcess(
      readFileSync(getDaemonPidPath(runtimeDir, protocolVersion), 'utf8')
    )
  } catch (error) {
    return mayBeAliveAfter(error)
  }
}

/** The same answer without blocking the thread: for callers on the main process's hot paths. */
export async function legacyDaemonProcessMayBeAliveAsync(
  runtimeDir: string,
  protocolVersion: number
): Promise<boolean> {
  try {
    return pidFileNamesExistingProcess(
      await readFile(getDaemonPidPath(runtimeDir, protocolVersion), 'utf8')
    )
  } catch (error) {
    return mayBeAliveAfter(error)
  }
}

function pidFileNamesExistingProcess(content: string): boolean {
  const parsed = parseDaemonPidFile(content)
  if (!parsed) {
    return false
  }
  process.kill(parsed.pid, 0)
  return true
}

function mayBeAliveAfter(error: unknown): boolean {
  // EPERM: the process exists under another user; only a missing pid file or ESRCH proves it gone.
  return hasErrorCode(error, 'EPERM')
}
