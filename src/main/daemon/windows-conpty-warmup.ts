import os from 'node:os'
import type { TerminalProcess } from '../../shared/terminal-process'
import type { BunPtySpawnArgs } from './pty-subprocess/bun-pty-process-contract'
import { spawnBunPty } from './pty-subprocess/bun-pty-process'
import { getCmdExePath } from '../../shared/windows-batch-spawn'

const WARMUP_KILL_TIMEOUT_MS = 10_000
type WarmupSpawn = (args: BunPtySpawnArgs) => Pick<TerminalProcess, 'kill' | 'onExit'>

/** Pays first ConPTY startup costs without delaying the daemon handshake. */
export function warmWindowsConptyOnce(spawnPty: WarmupSpawn = spawnBunPty): void {
  if (process.platform !== 'win32') {
    return
  }
  setImmediate(() => {
    try {
      const env: Record<string, string> = {}
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) {
          env[key] = value
        }
      }
      const proc = spawnPty({
        file: getCmdExePath(),
        args: ['/d', '/c', 'exit', '0'],
        cols: 2,
        rows: 1,
        cwd: os.homedir(),
        env,
        windowsJobKillOnClose: true
      })
      const killTimer = setTimeout(() => {
        try {
          proc.kill()
        } catch {
          // Best-effort cleanup of a stuck warm-up shell.
        }
      }, WARMUP_KILL_TIMEOUT_MS)
      killTimer.unref?.()
      let exited = false
      let subscription: { dispose(): void } | undefined
      subscription = proc.onExit(() => {
        exited = true
        clearTimeout(killTimer)
        subscription?.dispose()
      })
      if (exited) {
        subscription.dispose()
      }
    } catch {
      // Warm-up is best-effort; real spawns surface their own errors.
    }
  })
}
