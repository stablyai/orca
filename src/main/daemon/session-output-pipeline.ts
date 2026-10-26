import { SessionOutputPlane } from './session-output-plane'
import { TerminalShellRecoveryBarrier } from './terminal-shell-recovery-barrier'
import type { SubprocessHandle } from './session-subprocess-handle'
import { release } from 'node:os'
import type { PtyOwnerBackend } from '../../shared/pty-owner-backend'
import { buildXtermConptyOptions, parseWindowsBuildNumber } from '../../shared/xterm-conpty-options'

/** Couple barrier emissions and snapshot ownership so neither can lag the output plane. */
export function createSessionOutputPipeline(opts: {
  cols: number
  rows: number
  scrollback?: number | undefined
  wslDistro?: string | undefined
  historySeedChunks?: readonly string[] | undefined
  ownerBackend?: PtyOwnerBackend | undefined
  subprocess: SubprocessHandle
  isAlive: () => boolean
}): { output: SessionOutputPlane; recoveryBarrier: TerminalShellRecoveryBarrier } {
  const { subprocess, isAlive } = opts
  let barrier: TerminalShellRecoveryBarrier | null = null
  const output = new SessionOutputPlane({
    cols: opts.cols,
    rows: opts.rows,
    scrollback: opts.scrollback,
    wslDistro: opts.wslDistro,
    historySeedChunks: opts.historySeedChunks,
    // Every Windows daemon PTY is ConPTY, WSL shells included; ConPTY repaints its own grid after a
    // resize, so the emulator must not pull scrollback into it (xterm's windowsPty resize model).
    windowsPty:
      opts.ownerBackend && opts.ownerBackend !== 'posix-pty'
        ? buildXtermConptyOptions(parseWindowsBuildNumber(release()))
        : undefined,
    getTerminalOwner: () => barrier?.getOwner()
  })
  const recoveryBarrier = new TerminalShellRecoveryBarrier({
    confirmShellForeground: async () => (await subprocess.confirmShellForeground?.()) ?? false,
    release: (emission) => output.emit(emission),
    isAlive
  })
  barrier = recoveryBarrier
  return { output, recoveryBarrier }
}
