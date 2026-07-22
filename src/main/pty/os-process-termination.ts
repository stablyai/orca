import { execFile } from 'node:child_process'

/**
 * Force-kill a process and its descendant tree out-of-band, WITHOUT touching
 * node-pty's ConPTY handle.
 *
 * Why out-of-band: re-entering node-pty's own kill()/destroy() after it already
 * closed ConPTY double-closes the native handle (heap corruption). taskkill and
 * process.kill target the OS process directly, so they never risk that — while
 * still reaping a child a wedged ConPTY refuses to terminate.
 *
 * Windows: `taskkill /T /F` walks and kills the whole tree, reaping the orphan
 * descendants ConPTY leaves behind. POSIX: SIGKILL the pid (callers needing
 * process-group semantics use forceKillPosixPtyProcessGroups instead).
 *
 * @param pid Root process id. Non-positive/non-integer ids are ignored.
 * @param onFailure Invoked when the kill did not go through (Windows taskkill
 *   error, or a POSIX signal error other than ESRCH). Callers must use this to
 *   re-arm their escalation state — a swallowed failure would latch the owner
 *   into a terminating state it can never leave.
 */
export function killOsProcessTree(pid: number, onFailure?: (error: Error) => void): void {
  if (!Number.isInteger(pid) || pid <= 0) {
    return
  }
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], (error) => {
      // Why: taskkill is denied for elevated/protected children; report so the caller can retry.
      if (error) {
        onFailure?.(error)
      }
    })
    return
  }
  try {
    process.kill(pid, 'SIGKILL')
  } catch (error) {
    // Why: ESRCH proves the child is already gone (success); anything else (e.g. EPERM) is a real failure.
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      onFailure?.(error as Error)
    }
  }
}

/**
 * Existence check via signal 0 (works on Windows and POSIX). ESRCH proves the
 * pid is gone; EPERM means it exists but is owned by another user (still alive).
 * Any other/ambiguous error is treated as "assume alive" so a probe failure can
 * never make a caller synthesize an exit for a process that is still running.
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}
