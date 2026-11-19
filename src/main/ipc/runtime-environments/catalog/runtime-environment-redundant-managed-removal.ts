import {
  redactRuntimeEnvironment,
  type KnownRuntimeEnvironment,
  type RuntimeEnvironmentRemoval
} from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { findManagedSshTwin } from '../../../../shared/remote-runtime/host-catalog/runtime-environment-host-key-match'
import { listEnvironments } from '../../../../shared/remote-runtime/host-store/runtime-environment-store'
import { getManagedServerActions } from '../../../runtime/hosts/management/managed-server-actions-registry'

/**
 * Removes one of two saved entries for a managed server reached through two SSH aliases.
 * The other entry still manages that server, so this entry is unlinked here without touching the host.
 * Null when no other entry manages the same server; the store's guard then keeps the pairing.
 */
export async function removeRedundantManagedPairing(
  userDataPath: string,
  environment: KnownRuntimeEnvironment
): Promise<RuntimeEnvironmentRemoval | null> {
  const actions = getManagedServerActions()
  if (!actions || !findManagedSshTwin(await listEnvironments(userDataPath), environment)) {
    return null
  }
  // Forget is the managed removal: it also closes this entry's tunnel and releases its SSH claims.
  return actions.forgetRedundant(environment.id).then((result) => {
    if (result.outcome === 'refused') {
      throw new Error(result.reason)
    }
    return { removed: redactRuntimeEnvironment(environment) }
  })
}
