import type { TerminalProcess } from '../shared/terminal-process'
import { waitForPromiseWithSignal } from '../shared/abort-signal-reason'
import { spawnBunPty } from '../main/daemon/pty-subprocess/bun-pty-process'

export type RelayPtySpawnOptions = {
  name: string
  cols: number
  rows: number
  cwd: string
  env: Record<string, string>
}

export type RelayPtyModule = {
  spawn(
    file: string,
    args: string[],
    options: RelayPtySpawnOptions,
    signal?: AbortSignal
  ): TerminalProcess | Promise<TerminalProcess>
}

export const bunRelayPtyModule: RelayPtyModule = {
  async spawn(file, args, options, signal) {
    signal?.throwIfAborted()
    const terminal = spawnBunPty({
      file,
      args,
      cwd: options.cwd,
      cols: options.cols,
      rows: options.rows,
      env: { ...options.env, TERM: options.name }
    })
    try {
      if (terminal.waitForSpawn) {
        await waitForPromiseWithSignal(terminal.waitForSpawn(), signal)
      }
      signal?.throwIfAborted()
      return terminal
    } catch (error) {
      // A failed or cancelled receipt must not leave a shell with no relay owner.
      try {
        terminal.destroy()
      } catch (cleanupError) {
        console.warn('[relay/pty] Failed to clean up an uncommitted shell:', cleanupError)
      }
      throw error
    }
  }
}
