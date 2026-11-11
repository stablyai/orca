import type { ProcessResult } from '@orca/process-host/process-spec'
import type { ServeUpdateHandoffState } from '../../shared/serve-update-handoff'

type ExitSignal = ProcessResult['signal']

export type InstallRequestedHandoff = Extract<
  ServeUpdateHandoffState,
  { phase: 'install-requested' }
>
export type ServeReadiness = 'not-expected' | 'pending' | 'verified' | 'failed'

export type ServeChildExit = {
  code: number | null
  signal: ExitSignal
  readiness: ServeReadiness
  signalWasForwarded: boolean
  childPid: number | undefined
}

export type ServeSupervisorDecision =
  /** The replacement failed its readiness check; already recorded on the handoff. */
  | { kind: 'exit'; code: number }
  /** A replacement for an update exited before serving its version. */
  | { kind: 'fail-replacement'; handoff: InstallRequestedHandoff; reason: string }
  /** The child died by a signal nobody forwarded; explain it instead of exiting quietly. */
  | { kind: 'signal-exit'; signal: ExitSignal }
  /** This child asked to install an update: wait for the new bundle, then serve from it. */
  | { kind: 'await-install'; handoff: InstallRequestedHandoff }

export function decideAfterServeChildExit(input: {
  exit: ServeChildExit
  expectedHandoff: InstallRequestedHandoff | null
  handoff: ServeUpdateHandoffState | null
  hasHandoffPath: boolean
}): ServeSupervisorDecision {
  const { exit, expectedHandoff, handoff } = input
  if (exit.readiness === 'failed') {
    return { kind: 'exit', code: 1 }
  }
  if (expectedHandoff && exit.readiness !== 'verified') {
    return {
      kind: 'fail-replacement',
      handoff: expectedHandoff,
      reason: `Replacement exited before serving version ${expectedHandoff.targetVersion}.`
    }
  }
  if (
    !input.hasHandoffPath ||
    handoff?.phase !== 'install-requested' ||
    (exit.childPid !== undefined && handoff.servingPid !== exit.childPid)
  ) {
    if (typeof exit.code === 'number' || exit.signalWasForwarded) {
      return { kind: 'exit', code: exit.code ?? 0 }
    }
    return { kind: 'signal-exit', signal: exit.signal }
  }
  return { kind: 'await-install', handoff }
}
