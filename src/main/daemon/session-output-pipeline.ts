import { SessionOutputPlane } from './session-output-plane'
import { TerminalShellRecoveryBarrier } from './terminal-shell-recovery-barrier'
import type { SubprocessHandle } from './session-subprocess-handle'

/** Couple barrier emissions and snapshot ownership so neither can lag the output plane. */
export function createSessionOutputPipeline(opts: {
  cols: number
  rows: number
  scrollback?: number | undefined
  wslDistro?: string | undefined
  historySeedChunks?: readonly string[] | undefined
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
