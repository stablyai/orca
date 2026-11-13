import { getPreferredPairedRuntimeConnection } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { runtimeEnvironmentConnectionPairingKey } from '../connections/runtime-environment-capability-evidence'
import { errorMessage } from '../../../../shared/error-message'
import { resolveEnvironment } from '../../../../shared/remote-runtime/host-store/runtime-environment-store'
import { getOrcadSshDeployment } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { managedOrcadRefusalNeedingUserCode } from '../../../managed-server/lifecycle/orcad-managed-tunnel-identity'
import {
  managedOrcadPairingFailureStands,
  recoverRefusedManagedOrcadPairing
} from '../../../managed-server/lifecycle/orcad-managed-tunnel'
import { withRuntimeEnvironmentStatusOwner } from '../connections/runtime-environment-request-connections'

/** Null leaves user-managed pairing recovery to the caller. */
export async function recoverRefusedManagedPairing(
  userDataPath: string,
  environmentId: string,
  recover: typeof recoverRefusedManagedOrcadPairing = recoverRefusedManagedOrcadPairing
): Promise<'built' | 'repaired' | null> {
  try {
    if (!getOrcadSshDeployment(await resolveEnvironment(userDataPath, environmentId))) {
      return null
    }
  } catch {
    return null
  }
  return recover(userDataPath, environmentId)
}

/** Null preserves ordinary reconnect; a promise owns the refused socket recovery. */
export async function handleManagedSharedControlRefusal(
  userDataPath: string,
  environmentId: string,
  recover: typeof recoverRefusedManagedOrcadPairing = recoverRefusedManagedOrcadPairing,
  failureStands: typeof managedOrcadPairingFailureStands = managedOrcadPairingFailureStands
): Promise<'retry' | 'stop' | null> {
  const expected = await resolveEnvironment(userDataPath, environmentId).catch(() => null)
  try {
    const outcome = await recoverRefusedManagedPairing(userDataPath, environmentId, recover)
    return outcome === null ? null : outcome === 'repaired' ? 'stop' : 'retry'
  } catch (error: unknown) {
    // A concurrent pairing has a successor owner this failure never judged.
    const code = managedOrcadRefusalNeedingUserCode(error)
    if (code && error instanceof Error && (await failureStands(userDataPath, environmentId))) {
      // Authentication refusal blocks retries until an explicit user connect.
      try {
        await withRuntimeEnvironmentStatusOwner(
          userDataPath,
          environmentId,
          (environment, owner) => {
            if (
              expected &&
              (environment.pairingRevision ?? environment.createdAt) ===
                (expected.pairingRevision ?? expected.createdAt) &&
              runtimeEnvironmentConnectionPairingKey(
                getPreferredPairedRuntimeConnection(environment)
              ) ===
                runtimeEnvironmentConnectionPairingKey(
                  getPreferredPairedRuntimeConnection(expected)
                )
            ) {
              owner.authenticationRejected(error.message, code)
            }
          }
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
}
