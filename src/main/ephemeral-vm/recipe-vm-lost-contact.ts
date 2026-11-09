import type { EphemeralVmRuntimeRecord } from '../../shared/ephemeral-vm-runtimes'
import type { SshConnectionStatus } from '../../shared/ssh-types'

/** Recorded as up, but its host stopped answering. */
const RECOVERABLE_STATUSES: ReadonlySet<EphemeralVmRuntimeRecord['status']> = new Set([
  'running',
  'suspend_failed'
])

/**
 * An SSH-mode VM recorded as up whose SSH host Orca gave up reaching: the reconnect ladder spent
 * every attempt, minutes of failures, so the provider likely stopped or reclaimed it on its own
 * (#34089). The recipe's resume is then what brings it back. A blip, a reconnect still under way,
 * a host the user disconnected or one never dialed this session is not evidence, and is left to
 * the normal reconnects.
 */
export function isRecipeVmLostContact(
  runtime: Pick<EphemeralVmRuntimeRecord, 'status' | 'connectionMode' | 'sshTargetId'>,
  readSshStatus: (targetId: string) => SshConnectionStatus | undefined
): boolean {
  return (
    RECOVERABLE_STATUSES.has(runtime.status) &&
    runtime.connectionMode === 'ssh' &&
    runtime.sshTargetId !== undefined &&
    readSshStatus(runtime.sshTargetId) === 'reconnection-failed'
  )
}
