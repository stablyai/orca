import { PtyStartupIngress } from '../../shared/pty-startup-ingress'
import type { SessionOptions } from './session-options'
import type { SessionOutputPlane } from './session-output-plane'
import type { SessionShellReadyBarrier } from './session-shell-ready-barrier'
import type { SubprocessHandle } from './session-subprocess-handle'
import { SessionCommandMarkerIntake } from './session-command-marker-intake'
import { SessionSnapshotAccess } from './session-snapshot-access'
import type { TerminalShellRecoveryBarrier } from './terminal-shell-recovery-barrier'

export function createSessionIngressPipeline(args: {
  options: SessionOptions
  subprocess: SubprocessHandle
  output: SessionOutputPlane
  shellReady: SessionShellReadyBarrier
  recoveryBarrier: TerminalShellRecoveryBarrier
}): {
  commandMarkerIntake: SessionCommandMarkerIntake
  startupIngress: PtyStartupIngress
  snapshotAccess: SessionSnapshotAccess
} {
  const commandMarkerIntake = new SessionCommandMarkerIntake(
    args.subprocess.shellCommandMarkersEnabled === true,
    args.subprocess.shellCommandNonce ?? null,
    (emission) => args.recoveryBarrier.accept(emission),
    args.options.onPrivateTerminalFact
  )
  const startupIngress = new PtyStartupIngress({
    ...(args.options.startupIngress ? { intent: args.options.startupIngress } : {}),
    ...(args.options.ownerBackend ? { ownerBackend: args.options.ownerBackend } : {}),
    write: (data) => args.subprocess.write(data),
    onEmission: (emission) => commandMarkerIntake.accept(emission)
  })
  return {
    commandMarkerIntake,
    startupIngress,
    snapshotAccess: new SessionSnapshotAccess(
      args.output,
      args.shellReady,
      startupIngress,
      args.recoveryBarrier
    )
  }
}
