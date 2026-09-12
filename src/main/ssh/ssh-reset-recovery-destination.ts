import type { SshConnection } from './ssh-connection'
import { parseSshConnectionDestination } from './ssh-connection-destination'
import type { SshRelayResetIntent } from './ssh-relay-reset-intent'

export type SshResetRecoveryConnection = Pick<
  SshConnection,
  'exec' | 'usesSystemSshTransport' | 'getExecutionDestination' | 'getTransportGeneration'
>

/** Reconnect may match persisted identity, but this read must retain one exact transport. */
export function captureSshResetRecoveryDestination(
  intent: SshRelayResetIntent,
  connection: SshResetRecoveryConnection
): () => void {
  if (!intent.destination) {
    throw new Error('ssh_reset_recovery_destination_required')
  }
  const expected = JSON.stringify(parseSshConnectionDestination(intent.destination))
  const destination = connection.getExecutionDestination()
  const generation = connection.getTransportGeneration()
  const assertCurrent = (): void => {
    const current = connection.getExecutionDestination()
    if (
      connection.usesSystemSshTransport() ||
      !destination ||
      current !== destination ||
      connection.getTransportGeneration() !== generation ||
      JSON.stringify(parseSshConnectionDestination(current)) !== expected
    ) {
      throw new Error('ssh_reset_recovery_destination_changed')
    }
  }
  assertCurrent()
  return assertCurrent
}
