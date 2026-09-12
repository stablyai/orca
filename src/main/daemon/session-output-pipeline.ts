import { SessionOutputPlane } from './session-output-plane'
import { TerminalShellRecoveryBarrier } from './terminal-shell-recovery-barrier'
import type { SubprocessHandle } from './session-subprocess-handle'

/** The session's ordered output pipeline: the recovery barrier feeding the
 *  output plane. Built together because the barrier's owner is what the
 *  plane's snapshots publish, and the plane's emit is the barrier's sink. */
export function createSessionOutputPipeline(opts: {
  cols: number
  rows: number
  scrollback?: number | undefined
  wslDistro?: string | undefined
  historySeedChunks?: readonly string[] | undefined
  subprocess: SubprocessHandle
  isAlive: () => boolean
}): { output: SessionOutputPlane; recoveryBarrier: TerminalShellRecoveryBarrier } {
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
    confirmShellForeground: async () => (await opts.subprocess.confirmShellForeground?.()) ?? false,
    release: (emission) => output.emit(emission),
    isAlive: opts.isAlive
  })
  barrier = recoveryBarrier
  return { output, recoveryBarrier }
}
