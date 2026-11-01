import type { PtyChildProcessVerdict } from '../../shared/terminal-process-inspection'
import type { TerminalExitCause } from '../../shared/terminal-exit-cause'

import type { JobTerminationOutcome } from '../windows/windows-pty-job'

export type ChildProcessVerdictRead = PtyChildProcessVerdict | Promise<PtyChildProcessVerdict>

export type SubprocessHandle = {
  pid: number
  processNameIsSpawnFile?: boolean
  /** The job-control shell is the root's only child (macOS login(1) wrapper), not the root itself. */
  shellIsRootChild?: boolean
  inspectChildProcesses?(fresh?: boolean, ignoreDetached?: boolean): ChildProcessVerdictRead
  /** cachedOnly must neither query the process nor schedule inspection. */
  getForegroundProcess(options?: { rawFallback?: boolean; cachedOnly?: boolean }): string | null
  /** Await process-table evidence captured after this confirmation request. */
  confirmForegroundProcess?(context?: { decision?: boolean }): Promise<string | null>
  /** Proves a fresh post-boundary PTY process tree contains only the shell. */
  confirmShellForeground?(): Promise<boolean>
  /** Skip stdin command delivery when shell arguments already delivered it. */
  startupCommandDeliveredInShellArgs?: boolean
  /** Report the actual fallback shell so unsupported readiness markers cannot stall startup. */
  shellPath?: string
  shellCwd?: string
  shellPathEnv?: string
  /** POSIX slave path for reading line discipline; absent for ConPTY. */
  slavePath?: string
  write(data: string): void
  /** True once writes can no longer reach the PTY while the child may still be running. */
  isInputClosed?(): boolean
  /** Fires once when input closes for a reason other than child exit. */
  onInputClosed?(cb: (reason: string) => void): void
  resize(cols: number, rows: number): void
  /** Omit pause when the handle cannot apply PTY backpressure. */
  pause?(): void
  resume?(): void
  /** Resync ConPTY after frontend clears to prevent stale-row prompt repaint. */
  clear?(): void
  kill(): void
  /** Settles once signals are sent; a rejection means the kernel refused them. */
  forceKill(): void | Promise<void>
  /** Cover detached descendants via the PTY job; unavailable requires fallback and never proves death. */
  terminateOwnedTree(): JobTerminationOutcome
  signal(sig: string): void
  onData(cb: (data: string) => void): void
  onExit(cb: (code: number, cause?: TerminalExitCause) => void): void
  /** Release the native PTY handle idempotently, including after child exit. */
  dispose(): void
}
