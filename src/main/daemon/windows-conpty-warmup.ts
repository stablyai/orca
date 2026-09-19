import os from 'node:os'
import { createRequire } from 'node:module'
import type * as pty from 'node-pty'
import { canUseBunPty, spawnBunPty } from './pty-subprocess/bun-pty-process'

const WARMUP_KILL_TIMEOUT_MS = 10_000
const requireFromMain = createRequire(__filename)

function spawnWarmupPty(spawnPty?: typeof pty.spawn): pty.IPty {
  const file = process.env.COMSPEC || 'cmd.exe'
  const args = ['/c', 'exit']
  const cwd = os.homedir()
  const env = process.env as Record<string, string>
  if (spawnPty) {
    return spawnPty(file, args, {
      name: 'xterm-256color',
      cols: 2,
      rows: 1,
      cwd,
      env,
      useConptyDll: true
    })
  }
  if (canUseBunPty()) {
    return spawnBunPty({ file, args, cwd, env, cols: 2, rows: 1 })
  }
  const nodePty = requireFromMain('node-pty') as typeof pty
  return nodePty.spawn(file, args, {
    name: 'xterm-256color',
    cols: 2,
    rows: 1,
    cwd,
    env,
    useConptyDll: true
  })
}

/**
 * Pays the one-time cost of the first ConPTY spawn (conpty native module
 * load, bundled conpty.dll + OpenConsole.exe first launch, Defender scans of
 * those binaries) at daemon boot instead of on the user's first terminal.
 * Measured ~2.7s on a Windows dev profile for the first spawn vs ~70ms after.
 */
export function warmWindowsConptyOnce(spawnPty?: typeof pty.spawn): void {
  if (process.platform !== 'win32') {
    return
  }
  // Why: setImmediate keeps the ready/handshake path ahead of the warm-up; a
  // real spawn arriving first simply does the warming itself.
  setImmediate(() => {
    try {
      const proc = spawnWarmupPty(spawnPty)
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
