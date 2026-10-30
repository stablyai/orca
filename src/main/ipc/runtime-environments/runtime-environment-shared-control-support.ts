import type { PairedRuntimeConnection } from '../../../shared/paired-runtime-connection'
import type { KnownRuntimeEnvironment } from '../../../shared/runtime-environments'
import { RemoteRuntimeClientError } from '../../../shared/remote-runtime/remote-runtime-client-error'
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
  connection: PairedRuntimeConnection,
  timeoutMs: number
): Promise<RuntimeEnvironmentCapabilityOutcome> {
  const accepted = getAcceptedRuntimeEnvironmentCapabilityOutcome(
    environment.id,
    connection,
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
      connection,
      response._meta.runtimeId
    ) ?? { kind: 'stale_incarnation' }
  )
}
