export type DaemonExitRecord = {
  pid: number
  code: number | null
  signal: NodeJS.Signals | null
  atMs: number
}

let lastDaemonExit: DaemonExitRecord | null = null
// An older exit (a planned restart, say) must not be blamed for a later, unrelated death.
const DAEMON_EXIT_RECORD_TTL_MS = 60_000

/**
 * The daemon can vanish without writing its own log (for example a native abort when fork or thread
 * creation fails at a process limit), so record how this process saw it end (#39166).
 */
type ExitEmitter = {
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
}

export function watchLaunchedDaemonExit(child: ExitEmitter, pid: number): void {
  // A predecessor's exit (a planned restart, say) must not be blamed on this daemon's later death.
  lastDaemonExit = null
  let seen = false
  try {
    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      if (seen) {
        return
      }
      seen = true
      lastDaemonExit = { pid, code, signal, atMs: Date.now() }
      console.warn(`[daemon] Daemon process ${pid} exited: ${describeDaemonExit(lastDaemonExit)}`)
    })
  } catch {
    // Diagnostics only: a launch must never fail because its exit could not be watched.
  }
}

/** Exit facts for the respawn log; null when this process did not launch the daemon that died. */
export function takeLastDaemonExit(nowMs = Date.now()): DaemonExitRecord | null {
  const exit = lastDaemonExit
  lastDaemonExit = null
  return exit && nowMs - exit.atMs <= DAEMON_EXIT_RECORD_TTL_MS ? exit : null
}

export function describeDaemonExit(exit: Pick<DaemonExitRecord, 'code' | 'signal'>): string {
  if (exit.signal) {
    return `signal ${exit.signal}`
  }
  return exit.code === null ? 'unknown status' : `code ${exit.code}`
}

/** Shared by every respawn path so the main log says why the old daemon ended, when it is known. */
export function daemonDiedRespawnMessage(nowMs = Date.now()): string {
  const exit = takeLastDaemonExit(nowMs)
  // Unknown when another app session launched it, or when the socket closed before the exit event.
  return exit
    ? `[daemon] Daemon process died (pid ${exit.pid}, ${describeDaemonExit(exit)}) — respawning`
    : '[daemon] Daemon process died (exit status not observed) — respawning'
}
