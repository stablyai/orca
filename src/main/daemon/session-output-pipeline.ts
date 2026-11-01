import type { SubprocessHandle } from './session-subprocess-handle'
import { PtyStartupIngress } from '../../shared/pty-startup-ingress'

import { SessionShellReadyBarrier } from './session-shell-ready-barrier'
import { SessionOutputPlane } from './session-output-plane'
import { TerminalShellRecoveryBarrier } from './terminal-shell-recovery-barrier'
import { release } from 'node:os'
import type { SessionOptions } from './session-options'
import { windowsPtyForOwnerBackend } from '../../shared/xterm-conpty-options'

/** Couple barrier emissions and snapshot ownership so neither can lag the output plane. */
export function createSessionOutputPipeline(
  opts: SessionOptions,
  isAlive: () => boolean
): { output: SessionOutputPlane; recoveryBarrier: TerminalShellRecoveryBarrier } {
  const { subprocess } = opts
  let barrier: TerminalShellRecoveryBarrier | null = null
  const output = new SessionOutputPlane({
    cols: opts.cols,
    rows: opts.rows,
    scrollback: opts.scrollback,
    wslDistro: opts.wslDistro,
    historySeedChunks: opts.historySeedChunks,
    windowsPty: windowsPtyForOwnerBackend(opts.ownerBackend, release()),
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

export function createSessionStartupIngress(
  opts: Pick<SessionOptions, 'startupIngress' | 'ownerBackend'>,
  subprocess: SubprocessHandle,
  recoveryBarrier: TerminalShellRecoveryBarrier
): PtyStartupIngress {
  return new PtyStartupIngress({
    ...(opts.startupIngress ? { intent: opts.startupIngress } : {}),
    ...(opts.ownerBackend ? { ownerBackend: opts.ownerBackend } : {}),
    write: (data) => subprocess.write(data),
    onEmission: (emission) => recoveryBarrier.accept(emission)
  })
}

export function createSessionShellReady(
  opts: SessionOptions,
  output: SessionOutputPlane,
  acceptStartupIngress: (data: string, removed?: boolean) => void
): SessionShellReadyBarrier {
  return new SessionShellReadyBarrier({
    sessionId: opts.sessionId,
    subprocess: opts.subprocess,
    responderParser: output.responderParser,
    shellReadySupported: opts.shellReadySupported,
    nativeSetupToken: opts.nativeSetupToken,
    ...(opts.reportReadinessEvent ? { reportReadinessEvent: opts.reportReadinessEvent } : {}),
    shellReadyTimeoutMs: opts.shellReadyTimeoutMs,
    installDeviceAttributesFilter: () => output.installDeviceAttributesFilter(),
    releaseDeviceAttributesFilter: () => output.releaseDeviceAttributesFilter(),
    acceptStartupIngress
  })
}
