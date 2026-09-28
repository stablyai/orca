import type { SubprocessHandle } from './session-subprocess-handle'
import type { SessionShellReadyBarrier } from './session-shell-ready-barrier'
import type { SessionOutputPlane } from './session-output-plane'
import type { TerminalShellRecoveryBarrier } from './terminal-shell-recovery-barrier'
import type { PtyStartupIngress } from '../../shared/pty-startup-ingress'

/** A rejected subscription must release the parser and readiness resources it already created. */
export function installSessionOutputObservation(opts: {
  subprocess: SubprocessHandle
  shellReady: SessionShellReadyBarrier
  ingress: PtyStartupIngress
  recovery: TerminalShellRecoveryBarrier
  output: SessionOutputPlane
  isDisposed(): boolean
  onFailure(): void
  onExit: Parameters<SubprocessHandle['onExit']>[0]
}): void {
  try {
    opts.shellReady.startPromptReadinessProbe()
    opts.subprocess.onData((data) => {
      if (!opts.isDisposed()) {
        opts.shellReady.ingestSubprocessData(data)
      }
    })
    opts.subprocess.onExit(opts.onExit)
  } catch (error) {
    opts.onFailure()
    opts.shellReady.releaseDeviceAttributes()
    opts.shellReady.dispose()
    try {
      opts.ingress.drainAndClose()
    } finally {
      opts.recovery.dispose()
      opts.output.disposeEmulator()
    }
    throw error
  }
}
