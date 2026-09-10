import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_ATTEMPT_BOUND_WORKER_LEASE_PROTOCOL_VERSION,
  ORCHESTRATION_FEDERATION_ATTEMPT_BOUND_WORKER_LEASE_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION,
  ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION,
  ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
} from '../../../../../../shared/protocol-version'
import { orchestrationMigrationData } from '../../../../../../shared/orchestration-rpc-contract'
import type { RuntimeStatus } from '../../../../../../shared/runtime-types'
import type { WorkerStartInput } from '../worker/worker-start-schema'
import { OrchestrationError } from '../../../../orchestration/orchestration-error'
import { assertWorkerLaunchPreferencesRuntimeSupported } from '../worker/worker-launch-preferences'

export function negotiateFederatedWorkerProtocol(
  status: RuntimeStatus,
  params: WorkerStartInput,
  serverName: string
) {
  if (!status.capabilities?.includes(ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY)) {
    throw new OrchestrationError(
      'orchestration_migration_required',
      `Connected server ${serverName} does not support the current orchestration contract. No effects were applied.`,
      orchestrationMigrationData('runtime_capability_missing')
    )
  }
  if (!status.capabilities?.includes(ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY)) {
    throw new OrchestrationError(
      'capability_unsupported',
      `Connected server ${serverName} does not support orchestration federation.`
    )
  }

  assertWorkerLaunchPreferencesRuntimeSupported({
    model: params.model,
    effort: params.effort,
    capabilities: status.capabilities,
    serverName: serverName
  })
  // Why: mixed client and server versions are the normal state, so negotiate down to
  // the highest protocol this peer actually advertises. A capability the peer never
  // published is never assumed, and the attempt-bound identity below is sent only on
  // the version that defines it.
  const capabilities = status.capabilities ?? []
  const federationProtocolVersion = capabilities.includes(
    ORCHESTRATION_FEDERATION_ATTEMPT_BOUND_WORKER_LEASE_RUNTIME_CAPABILITY
  )
    ? ORCHESTRATION_FEDERATION_ATTEMPT_BOUND_WORKER_LEASE_PROTOCOL_VERSION
    : capabilities.includes(ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY) &&
        capabilities.includes(ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY)
      ? ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION
      : capabilities.includes(ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY)
        ? ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION
        : 1
  return federationProtocolVersion
}
