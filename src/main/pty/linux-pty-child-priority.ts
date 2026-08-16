import { constants, setPriority } from 'node:os'

/**
 * Reset an integrated PTY child's niceness to 0 on Linux.
 *
 * Why: Electron/Chromium runs the main process at nice -8. node-pty children
 * inherit that and so do Gradle/clang++ trees started from the terminal,
 * which can starve the desktop compositor (#14639). Only the child is
 * changed — never this process.
 */
export function resetLinuxPtyChildPriority(pid: number | undefined): boolean {
  if (process.platform !== 'linux') {
    return false
  }
  if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
    return false
  }
  try {
    setPriority(pid, constants.priority.PRIORITY_NORMAL)
    return true
  } catch {
    return false
  }
}
