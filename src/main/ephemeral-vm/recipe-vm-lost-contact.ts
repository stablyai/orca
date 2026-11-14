import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import type { SshConnectionStatus } from '../../shared/ssh-types'

/** Recorded as up, but its host stopped answering. */
const RECOVERABLE_STATUSES: ReadonlySet<EphemeralVmRuntimeRecord['status']> = new Set([
  'running',
  'suspend_failed'
])

export type RecipeVmContactEvidence = {
  readSshStatus: (targetId: string) => SshConnectionStatus | undefined
  /** Every contact with the paired server failed for minutes, it is not ready now, and the user
   *  did not disconnect it. */
  isServerContactLost: (environmentId: string) => boolean
}

/**
 * A VM recorded as up whose host Orca gave up reaching, so the provider likely stopped or
 * reclaimed it on its own (#34089). The recipe's resume is then what brings it back.
 * - SSH: the reconnect ladder spent every attempt, minutes of failures.
 * - Orca server: every health probe and control-socket reconnect failed for minutes.
 * A blip, a reconnect still under way, a host the user disconnected or one never dialed this
 * session is not evidence, and is left to the normal reconnects. Nothing here dials: the
 * evidence comes from dials Orca already makes, and none are made to a VM the user suspended.
 */
export function isRecipeVmLostContact(
  runtime: Pick<
    EphemeralVmRuntimeRecord,
    'status' | 'connectionMode' | 'sshTargetId' | 'runtimeEnvironmentId'
  >,
  evidence: RecipeVmContactEvidence
): boolean {
  if (!RECOVERABLE_STATUSES.has(runtime.status)) {
    return false
  }
  if (runtime.connectionMode === 'ssh') {
    return (
      runtime.sshTargetId !== undefined &&
      evidence.readSshStatus(runtime.sshTargetId) === 'reconnection-failed'
    )
  }
  return (
    runtime.connectionMode === 'orca-server' &&
    runtime.runtimeEnvironmentId !== undefined &&
    evidence.isServerContactLost(runtime.runtimeEnvironmentId)
  )
}
