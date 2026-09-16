import type {
  getPreferredPairingOffer,
  KnownRuntimeEnvironment
} from '../../shared/runtime-environments'
import { RemoteRuntimeClientError } from '../../shared/remote-runtime-client-error'
import {
  getAcceptedRuntimeEnvironmentCapabilityOutcome,
  resetRuntimeEnvironmentCapabilityEvidence,
  type RuntimeEnvironmentCapabilityOutcome
} from './runtime-environment-capability-evidence'
import {
  getRuntimeEnvironmentStatusOwner,
  resetRuntimeEnvironmentStatusOwners
} from './runtime-environment-request-connections'

export function resetSharedControlSupport(): void {
  resetRuntimeEnvironmentStatusOwners()
  resetRuntimeEnvironmentCapabilityEvidence()
}

export async function supportsSharedControl(
  userDataPath: string,
  environment: KnownRuntimeEnvironment,
  pairing: ReturnType<typeof getPreferredPairingOffer>,
  timeoutMs: number
): Promise<RuntimeEnvironmentCapabilityOutcome> {
  const accepted = getAcceptedRuntimeEnvironmentCapabilityOutcome(
    environment.id,
    pairing,
    environment.runtimeId
  )
  if (accepted) {
    return accepted
  }
  const response = await getRuntimeEnvironmentStatusOwner(userDataPath, environment.id).refresh({
    timeoutMs
  })
  if (!response.ok) {
    throw new RemoteRuntimeClientError(response.error.code, response.error.message)
  }
  return (
    getAcceptedRuntimeEnvironmentCapabilityOutcome(
      environment.id,
      pairing,
      response._meta.runtimeId
    ) ?? { kind: 'stale_incarnation' }
  )
}
