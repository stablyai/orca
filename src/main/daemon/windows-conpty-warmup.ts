import os from 'node:os'
import type * as pty from 'node-pty'
import { createRequire } from 'node:module'
import { assignHostProcessToKillOnCloseJob } from '../windows/windows-pty-job'

const WARMUP_KILL_TIMEOUT_MS = 10_000
const requireFromMain = createRequire(__filename)

const spawnWarmupPty: typeof pty.spawn = (file, args, options) => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: node-pty's installed package implements the declared spawn contract.
  const nodePty = requireFromMain('node-pty') as typeof pty
  return nodePty.spawn(file, args, options)
}

/** Move first-ConPTY startup cost ahead of the user’s first terminal when possible. */
export function warmWindowsConptyOnce(spawnPty: typeof pty.spawn = spawnWarmupPty): void {
  if (process.platform !== 'win32') {
    return
  }
  // Defer warmup so the daemon’s ready/handshake path can proceed first.
  setImmediate(() => {
    try {
      // Warm-up children must die with the daemon, even before its first real terminal.
      assignHostProcessToKillOnCloseJob()
      const proc = spawnPty(process.env.COMSPEC || 'cmd.exe', ['/c', 'exit'], {
        name: 'xterm-256color',
        cols: 2,
        rows: 1,
        cwd: os.homedir(),
        env: process.env as Record<string, string>,
        // Warm the bundled ConPTY binaries used by real terminal spawns.
        useConptyDll: true
      })
      const killTimer = setTimeout(() => {
        try {
          proc.kill()
        } catch {
          /* A stuck warmup shell must not make cleanup fail. */
        }
      }, WARMUP_KILL_TIMEOUT_MS)
      killTimer.unref?.()
      proc.onExit(() => {
        clearTimeout(killTimer)
      })
    } catch {
      /* Warmup is optional; real spawns report their own errors. */
    }
  })
}
