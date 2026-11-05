import {
  getOrcadSshDeployment,
  getPreferredPairedRuntimeConnection,
  redactRuntimeEnvironment,
  type KnownRuntimeEnvironment,
  type RuntimeEnvironmentRemoval
} from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import { listEnvironments } from '../../../shared/remote-runtime/host-store/runtime-environment-store'
import { getManagedServerActions } from '../../runtime/managed-server-actions-registry'

/**
 * Removes one of two saved entries for a managed server reached through two SSH aliases.
 * The other entry still manages that server, so this entry is unlinked here without touching the host.
 * Null when another entry does not manage the same server; the store's guard then keeps the pairing.
 */
export function removeRedundantManagedPairing(
  userDataPath: string,
  environment: KnownRuntimeEnvironment
): Promise<RuntimeEnvironmentRemoval> | null {
  const actions = getManagedServerActions()
  if (!actions || !getOrcadSshDeployment(environment)) {
    return null
  }
  const hostKey = getPreferredPairedRuntimeConnection(environment).hostPublicKeyB64
  const managedElsewhere = listEnvironments(userDataPath).some(
    (other) =>
      other.id !== environment.id &&
      getOrcadSshDeployment(other) !== undefined &&
      getPreferredPairedRuntimeConnection(other).hostPublicKeyB64 === hostKey
  )
  if (!managedElsewhere) {
    return null
  }
  // Forget is the managed removal: it also closes this entry's tunnel and releases its SSH claims.
  return actions.forget(environment.id).then((result) => {
    if (result.outcome === 'refused') {
      throw new Error(result.reason)
    }
    return { removed: redactRuntimeEnvironment(environment) }
  })
}
