import { spawn } from 'node:child_process'

/* Why: Windows has no SIGTERM-style catchable signal — node-pty's kill()
 * tears the ConPTY down immediately, giving agent CLIs (Claude Code, Codex)
 * zero time to flush buffered transcript writes. `taskkill /T` (no /F) asks
 * every process in the tree to close; the caller's bounded timeout then
 * escalates to `taskkill /T /F`. Both are best-effort: the caller always
 * follows up with node-pty's own kill/destroy to release the ConPTY. */

export const WINDOWS_FORCE_KILL_WAIT_MS = 2_000

function isValidPid(pid: number): boolean {
  return Number.isFinite(pid) && pid > 0
}

function runTaskkill(pid: number, args: string[]): ReturnType<typeof spawn> | null {
  if (!isValidPid(pid)) {
    return null
  }
  return spawn('taskkill', ['/pid', String(pid), ...args], {
    windowsHide: true,
    stdio: 'ignore'
  })
}

function runTaskkillDetached(pid: number, args: string[]): void {
  if (!Number.isFinite(pid) || pid <= 0) {
    return
  }
  try {
    const child = runTaskkill(pid, args)
    if (!child) {
      return
    }
    child.on('error', () => {
      /* taskkill missing or pid already gone — force paths still run */
    })
    child.unref()
  } catch {
    /* spawn failure is non-fatal; the force-kill fallback still fires */
  }
}

/** Ask a Windows process tree to exit gracefully (taskkill /T without /F). */
export function requestWindowsProcessTreeExit(pid: number): void {
  runTaskkillDetached(pid, ['/T'])
}

/** Force-terminate a Windows process tree (taskkill /T /F). */
export function forceKillWindowsProcessTree(pid: number): void {
  runTaskkillDetached(pid, ['/T', '/F'])
}

/** Force-terminate and wait a bounded window for taskkill to finish. */
export function waitForWindowsProcessTreeForceKill(
  pid: number,
  timeoutMs = WINDOWS_FORCE_KILL_WAIT_MS
): Promise<void> {
  if (!isValidPid(pid)) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let child: ReturnType<typeof spawn> | null = null
    const settle = (): void => {
      if (settled) {
        return
      }
      settled = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      resolve()
    }
    const settleAfterTimeout = (): void => {
      if (child) {
        try {
          child.kill()
        } catch {
          /* taskkill may have already exited */
        }
        child.unref()
      }
      settle()
    }
    try {
      child = runTaskkill(pid, ['/T', '/F'])
      if (!child) {
        settle()
        return
      }
      child.once('exit', settle)
      child.once('error', settle)
      timer = setTimeout(settleAfterTimeout, timeoutMs)
    } catch {
      settle()
    }
  })
}
