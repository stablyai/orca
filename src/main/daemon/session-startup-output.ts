import { PtyStartupIngress } from '../../shared/pty-startup-ingress'
import type { SessionOptions } from './session-options'
import type { SubprocessHandle } from './session-subprocess-handle'
import type { SessionShellReadyBarrier } from './session-shell-ready-barrier'
import type { TerminalShellRecoveryBarrier } from './terminal-shell-recovery-barrier'

export function createSessionIngress(
  opts: SessionOptions,
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

export function drainSessionStartup(
  shellReady: SessionShellReadyBarrier,
  startupIngress: PtyStartupIngress,
  recoveryBarrier: TerminalShellRecoveryBarrier
): void {
  shellReady.releaseDeviceAttributes()
  shellReady.releaseHeldBytes()
  startupIngress.drainAndClose()
  // Drain before notifying exits or disposing the attached output plane.
  recoveryBarrier.flushPending()
}
