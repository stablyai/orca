import { SessionOutputPlane } from './session-output-plane'
import { TerminalShellRecoveryBarrier } from './terminal-shell-recovery-barrier'
import { SessionShellReadyBarrier } from './session-shell-ready-barrier'
import { PtyStartupIngress } from '../../shared/pty-startup-ingress'
import type { SessionOptions } from './session-options'

/** Builds the ordered startup gates and output plane together, with one cleanup owner. */
export function createSessionOutputPipeline(
  opts: SessionOptions,
  isAlive: () => boolean,
  acceptStartupIngress: (data: string) => void
): {
  output: SessionOutputPlane
  recoveryBarrier: TerminalShellRecoveryBarrier
  shellReady: SessionShellReadyBarrier
  startupIngress: PtyStartupIngress
} {
  const { subprocess } = opts
  let barrier: TerminalShellRecoveryBarrier | null = null
  let shellReady: SessionShellReadyBarrier | undefined
  let startupIngress: PtyStartupIngress | undefined
  const output = new SessionOutputPlane({
    cols: opts.cols,
    rows: opts.rows,
    scrollback: opts.scrollback,
    wslDistro: opts.wslDistro,
    historySeedChunks: opts.historySeedChunks,
    preparedHistorySeed: opts.preparedHistorySeed,
    getTerminalOwner: () => barrier?.getOwner()
  })
  try {
    const recoveryBarrier = new TerminalShellRecoveryBarrier({
      confirmShellForeground: async () => (await subprocess.confirmShellForeground?.()) ?? false,
      release: (emission) => output.emit(emission),
      isAlive
    })
    barrier = recoveryBarrier
    shellReady = new SessionShellReadyBarrier({
      sessionId: opts.sessionId,
      subprocess,
      responderParser: output.responderParser,
      shellReadySupported: opts.shellReadySupported,
      ...(opts.reportReadinessEvent ? { reportReadinessEvent: opts.reportReadinessEvent } : {}),
      shellReadyTimeoutMs: opts.shellReadyTimeoutMs,
      installDeviceAttributesFilter: () => output.installDeviceAttributesFilter(),
      releaseDeviceAttributesFilter: () => output.releaseDeviceAttributesFilter(),
      acceptStartupIngress
    })
    startupIngress = new PtyStartupIngress({
      ...(opts.startupIngress ? { intent: opts.startupIngress } : {}),
      ...(opts.ownerBackend ? { ownerBackend: opts.ownerBackend } : {}),
      write: (data) => subprocess.write(data),
      onEmission: (emission) => recoveryBarrier.accept(emission)
    })
    return { output, recoveryBarrier, shellReady, startupIngress }
  } catch (error) {
    startupIngress?.discardAndClose()
    shellReady?.dispose()
    barrier?.dispose()
    output.disposeEmulator()
    throw error
  }
}
