import os from 'node:os'
import * as pty from 'node-pty'

const WARMUP_KILL_TIMEOUT_MS = 10_000

/**
 * Pays the one-time cost of the first ConPTY spawn (conpty native module
 * load, bundled conpty.dll + OpenConsole.exe first launch, Defender scans of
 * those binaries) at daemon boot instead of on the user's first terminal.
 * Measured ~2.7s on a Windows dev profile for the first spawn vs ~70ms after.
 */
export function warmWindowsConptyOnce(spawnPty: typeof pty.spawn = pty.spawn): void {
  if (process.platform !== 'win32') {
    return
  }
  // Why: setImmediate keeps the ready/handshake path ahead of the warm-up; a
  // real spawn arriving first simply does the warming itself.
  setImmediate(() => {
    try {
      const proc = spawnPty(process.env.COMSPEC || 'cmd.exe', ['/c', 'exit'], {
        name: 'xterm-256color',
        cols: 2,
        rows: 1,
        cwd: os.homedir(),
        env: process.env as Record<string, string>,
        // Match real terminal spawns so the bundled ConPTY binaries are the
        // ones warmed, not the legacy system ConPTY.
        useConptyDll: true
      })
      const killTimer = setTimeout(() => {
        try {
          proc.kill()
        } catch {
          /* best-effort cleanup of a stuck warm-up shell */
        }
      }, WARMUP_KILL_TIMEOUT_MS)
      killTimer.unref?.()
      proc.onExit(() => {
        clearTimeout(killTimer)
      })
    } catch {
      /* warm-up is best-effort; real spawns surface their own errors */
    }
  })
}
