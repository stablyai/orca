import { SessionOutputPlane } from './session-output-plane'
import { TerminalShellRecoveryBarrier } from './terminal-shell-recovery-barrier'
import { release } from 'node:os'
import type { SubprocessHandle } from './session-subprocess-handle'
import type { PtyOwnerBackend } from '../../shared/pty-owner-backend'
import { windowsPtyForOwnerBackend } from '../../shared/xterm-conpty-options'

/** Couple barrier emissions and snapshot ownership so neither can lag the output plane. */
export function createSessionOutputPipeline(opts: {
  startupCommand?: string
  cols: number
  incarnationId?: string
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
    subprocess,
    startupCommand: opts.startupCommand,
    incarnationId: opts.incarnationId,
    rows: opts.rows,
    scrollback: opts.scrollback,
    wslDistro: opts.wslDistro,
    historySeedChunks: opts.historySeedChunks,
    windowsPty: windowsPtyForOwnerBackend(opts.ownerBackend, release()),
    getTerminalOwner: () => barrier?.getOwner()
  })
  const recoveryBarrier = new TerminalShellRecoveryBarrier({
    confirmShellForeground: async () => (await subprocess.confirmShellForeground?.()) ?? false,
    release: (emission, genuinePrefixLength) => output.emit(emission, genuinePrefixLength),
    isAlive
  })
  barrier = recoveryBarrier
  return { output, recoveryBarrier }
}
