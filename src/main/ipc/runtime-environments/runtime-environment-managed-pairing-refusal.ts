/** A server managed over SSH refused this desktop's token: pair again over SSH, or say why not. */
import { errorMessage } from '../../../shared/error-message'
import { resolveEnvironment } from '../../../shared/runtime-environment-store'
import { getOrcadSshDeployment } from '../../../shared/runtime-environments'
import { OrcadManagedPairingRepairFailedError } from '../../managed-server/lifecycle/orcad-managed-pairing-repair-failure'
import {
  managedOrcadPairingFailureStands,
  recoverRefusedManagedOrcadPairing
} from '../../managed-server/lifecycle/orcad-managed-tunnel'
import { getRuntimeEnvironmentStatusOwner } from './runtime-environment-request-connections'

/** Null for anything but a server managed over SSH; other servers are paired by their user. */
export function recoverRefusedManagedPairing(
  userDataPath: string,
  environmentId: string,
  recover: typeof recoverRefusedManagedOrcadPairing = recoverRefusedManagedOrcadPairing
): Promise<'built' | 'repaired'> | null {
  try {
    if (!getOrcadSshDeployment(resolveEnvironment(userDataPath, environmentId))) {
      return null
    }
  } catch {
    return null
  }
  return recover(userDataPath, environmentId)
}

/** Null keeps the usual reconnect; otherwise whether the refused socket should retry. */
export function handleManagedSharedControlRefusal(
  userDataPath: string,
  environmentId: string,
  recover: typeof recoverRefusedManagedOrcadPairing = recoverRefusedManagedOrcadPairing,
  failureStands: typeof managedOrcadPairingFailureStands = managedOrcadPairingFailureStands
): Promise<'retry' | 'stop'> | null {
  const recovery = recoverRefusedManagedPairing(userDataPath, environmentId, recover)
  if (!recovery) {
    return null
  }
  return recovery.then(
    // A re-pair retired this socket for one on the new pairing; otherwise retry with backoff.
    (outcome) => (outcome === 'repaired' ? 'stop' : 'retry'),
    (error: unknown) => {
      // Why fenced: a newer pairing stored meanwhile has a successor owner this failure never judged.
      if (
        error instanceof OrcadManagedPairingRepairFailedError &&
        failureStands(userDataPath, environmentId)
      ) {
        // Why stop: the verdict stands until the user connects again.
        try {
          getRuntimeEnvironmentStatusOwner(userDataPath, environmentId).authenticationRejected(
            error.message
          )
        } catch {
          // Removed while it re-paired: nothing is left to report on.
        }
        return 'stop'
      }
      // Lost contact or a foreign answer is not a verdict on the pairing.
      console.warn(
        '[runtime-environments] Could not re-pair the managed Orca server:',
        errorMessage(error)
      )
      return 'retry'
    }
  )
}
