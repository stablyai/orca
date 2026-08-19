import type { TerminalExitCause } from '../../shared/terminal-exit-cause'

export type SubprocessHandle = {
  pid: number
  /** Live foreground process name of the PTY (node-pty's `.process`), e.g.
   *  'claude' / 'codex' / 'zsh'. Null once the child has exited. */
  getForegroundProcess(): string | null
  /** Await process-table evidence captured after this confirmation request. */
  confirmForegroundProcess?(): Promise<string | null>
  /** True when shell launch args already delivered the startup command, so the host skips its stdin fallback write. */
  startupCommandDeliveredInShellArgs?: boolean
  /** Shell the subprocess actually spawned, after fallbacks. The host reconciles the caller's shell-ready
   *  assumption against it so a fallback shell without a ready marker never gates startup commands. */
  shellPath?: string
  shellCwd?: string
  shellPathEnv?: string
  /** Slave device path, so startup replies can read the line discipline's ECHO bit before
   *  writing. Absent on handles with no POSIX slave to read (ConPTY, tests). */
  slavePath?: string
  write(data: string): void
  resize(cols: number, rows: number): void
  /** Stop reading the PTY fd (node-pty pause()) so a flooding child blocks on write. Optional:
   *  handles that cannot pause omit it and flow control degrades to a no-op. */
  pause?(): void
  resume?(): void
  /** Resync the native PTY's screen state after a frontend clear. No-op except on Windows/ConPTY,
   *  where a stale cursor row makes the next prompt repaint below a blank gap. */
  clear?(): void
  kill(): void
  forceKill(): void
  signal(sig: string): void
  onData(cb: (data: string) => void): void
  onExit(cb: (code: number, cause?: TerminalExitCause) => void): void
  /** Release the native PTY handle via node-pty's destroy(). Idempotent; safe to call after exit. */
  dispose(): void
}
