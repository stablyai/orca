import os from 'node:os'
import type * as pty from 'node-pty'
import { createRequire } from 'node:module'
import { canUseBunPty, spawnBunPty } from './pty-subprocess/bun-pty-process'
import { assignHostProcessToKillOnCloseJob } from '../windows/windows-pty-job'

const WARMUP_KILL_TIMEOUT_MS = 10_000
const requireFromMain = createRequire(__filename)

const spawnWarmupPty: typeof pty.spawn = (file, args, options) => {
  if (canUseBunPty()) {
    if (!Array.isArray(args)) {
      throw new Error('Bun PTY requires argument arrays')
    }
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(options.env ?? process.env)) {
      if (value !== undefined) {
        env[key] = value
      }
    }
    return spawnBunPty({
      file,
      args,
      cwd: options.cwd ?? os.homedir(),
      env,
      cols: options.cols ?? 2,
      rows: options.rows ?? 1
    })
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: node-pty's installed package implements the declared spawn contract.
  const nodePty = requireFromMain('node-pty') as typeof pty
  return nodePty.spawn(file, args, options)
}

/**
 * Pays the one-time cost of the first ConPTY spawn (conpty native module
 * load, bundled conpty.dll + OpenConsole.exe first launch, Defender scans of
 * those binaries) at daemon boot instead of on the user's first terminal.
 * Measured ~2.7s on a Windows dev profile for the first spawn vs ~70ms after.
 */
export function warmWindowsConptyOnce(spawnPty: typeof pty.spawn = spawnWarmupPty): void {
  if (process.platform !== 'win32') {
    return
  }
  // Why: setImmediate keeps the ready/handshake path ahead of the warm-up; a
  // real spawn arriving first simply does the warming itself.
  setImmediate(() => {
    try {
      // Warm-up children must die with the daemon, even before its first real terminal.
      if (!canUseBunPty()) {
        assignHostProcessToKillOnCloseJob()
      }
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
