import {
  getOrcadSshDeployment,
  type KnownRuntimeEnvironment
} from '../../../shared/remote-runtime/host-catalog/runtime-environments'
import { moveManagedOrcadRemotePort } from '../../../shared/remote-runtime/host-store/runtime-environment-managed-orcad-store'
import { orcadBoundPort, readActiveManagedOrcadReadiness } from './orcad-managed-bound-port'
import { resolveLinkedOrcadContext } from './orcad-managed-runtime-context'
import {
  OrcadManagedIdentityError,
  verifyManagedOrcadTunnelIdentity
} from './orcad-managed-tunnel-identity'

export async function reconcileManagedOrcadRemotePort(
  userDataPath: string,
  environment: KnownRuntimeEnvironment,
  remotePort: number
): Promise<KnownRuntimeEnvironment> {
  const deployment = getOrcadSshDeployment(environment)
  if (!deployment) {
    throw new Error('This server is not managed over SSH.')
  }
  if (deployment.remotePort === remotePort) {
    return environment
  }
  const identity = await verifyManagedOrcadTunnelIdentity(environment)
  const verifiedRuntimeId = identity.verdict === 'verified' ? identity.runtimeId : null
  if (
    !verifiedRuntimeId ||
    (environment.runtimeId !== null && environment.runtimeId !== verifiedRuntimeId)
  ) {
    throw OrcadManagedIdentityError.unverifiedRemotePort(
      remotePort,
      identity.verdict === 'verified'
        ? 'The active runtime identity does not match the saved deployment.'
        : identity.detail
    )
  }
  try {
    const context = await resolveLinkedOrcadContext(environment, deployment)
    const readiness = await readActiveManagedOrcadReadiness(context)
    if (readiness?.runtimeId !== verifiedRuntimeId || orcadBoundPort(readiness) !== remotePort) {
      throw new Error('The active slot did not confirm this runtime and bound port.')
    }
  } catch (error) {
    throw OrcadManagedIdentityError.unverifiedRemotePort(
      remotePort,
      error instanceof Error ? error.message : String(error)
    )
  }
  return await moveManagedOrcadRemotePort(userDataPath, environment.id, {
    expectedPairingRevision: environment.pairingRevision ?? environment.createdAt,
    expectedRemotePort: deployment.remotePort,
    remotePort,
    verifiedRuntimeId
  })
}
