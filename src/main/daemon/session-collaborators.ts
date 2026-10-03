import type { SessionOutputPlane } from './session-output-plane'
import { createSessionOutputPipeline } from './session-output-pipeline'
import { SessionProducerPause } from './session-producer-pause'
import { SessionShellReadyBarrier } from './session-shell-ready-barrier'
import type { TerminalShellRecoveryBarrier } from './terminal-shell-recovery-barrier'
import { SessionTerminationController } from './session-termination-controller'
import type { SubprocessHandle } from './session-subprocess-handle'
import type { SessionOptions } from './session-options'
import type { TuiAgent } from '../../shared/tui-agent'
import { PtyStartupIngress } from '../../shared/pty-startup-ingress'

export type SessionCollaborators = {
  output: SessionOutputPlane
  recoveryBarrier: TerminalShellRecoveryBarrier
  producerPause: SessionProducerPause
  termination: SessionTerminationController
  shellReady: SessionShellReadyBarrier
  startupIngress: PtyStartupIngress
}

export type SessionCollaboratorOwner = {
  sessionId: string
  subprocess: SubprocessHandle
  launchAgent: TuiAgent | null
  isAlive: () => boolean
  isExited: () => boolean
}

/** Builds a Session's output, pause, termination, shell-ready and startup-ingress collaborators in dependency order. */
export function createSessionCollaborators(
  opts: SessionOptions,
  owner: SessionCollaboratorOwner
): SessionCollaborators {
  const pipeline = createSessionOutputPipeline({
    cols: opts.cols,
    rows: opts.rows,
    scrollback: opts.scrollback,
    wslDistro: opts.wslDistro,
    historySeedChunks: opts.historySeedChunks,
    subprocess: owner.subprocess,
    isAlive: owner.isAlive
  })
  const output = pipeline.output
  const recoveryBarrier = pipeline.recoveryBarrier
  const producerPause = new SessionProducerPause(owner.subprocess)
  const termination = new SessionTerminationController({
    sessionId: owner.sessionId,
    subprocess: owner.subprocess,
    launchAgent: owner.launchAgent,
    isExited: owner.isExited,
    releaseProducerPause: (pauseOpts) => producerPause.release(pauseOpts)
  })

  const shellReady = new SessionShellReadyBarrier({
    sessionId: owner.sessionId,
    subprocess: owner.subprocess,
    responderParser: output.responderParser,
    shellReadySupported: opts.shellReadySupported,
    ...(opts.reportReadinessEvent ? { reportReadinessEvent: opts.reportReadinessEvent } : {}),
    shellReadyTimeoutMs: opts.shellReadyTimeoutMs,
    installDeviceAttributesFilter: () => output.installDeviceAttributesFilter(),
    releaseDeviceAttributesFilter: () => output.releaseDeviceAttributesFilter(),
    acceptStartupIngress: (data) => startupIngress.accept(data)
  })

  const startupIngress = new PtyStartupIngress({
    ...(opts.startupIngress ? { intent: opts.startupIngress } : {}),
    ...(opts.ownerBackend ? { ownerBackend: opts.ownerBackend } : {}),
    write: (data) => owner.subprocess.write(data),
    onEmission: (emission) => recoveryBarrier.accept(emission)
  })
  return { output, recoveryBarrier, producerPause, termination, shellReady, startupIngress }
}
