import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_COMMANDER_DISPATCH_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION,
  ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION,
  ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
} from '../../../../shared/orchestration/orchestration-runtime-capabilities'
import { orchestrationMigrationData } from '../../../../shared/orchestration/orchestration-rpc-contract'
import { OrchestrationError } from '../orchestration-error'
import { assertWorkerLaunchPreferencesRuntimeSupported } from '../../rpc/methods/orchestration/worker/start/launch/worker-launch-preferences'
import type { WorkerStartInput } from '../../rpc/methods/orchestration/worker/start/worker-start-input'

export function federatedWorkerStartProtocol(
  params: WorkerStartInput,
  serverName: string,
  capabilities: readonly string[] | undefined
) {
  if (!capabilities?.includes(ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY)) {
    throw new OrchestrationError(
      'orchestration_migration_required',
      `Connected server ${serverName} does not support the current orchestration contract. No effects were applied.`,
      orchestrationMigrationData('runtime_capability_missing')
    )
  }
  if (!capabilities?.includes(ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY)) {
    throw new OrchestrationError(
      'capability_unsupported',
      `Connected server ${serverName} does not support orchestration federation.`
    )
  }
  if (
    params.commander &&
    !capabilities?.includes(ORCHESTRATION_COMMANDER_DISPATCH_RUNTIME_CAPABILITY)
  ) {
    throw new OrchestrationError(
      'capability_unsupported',
      'The remote Orca host does not support Commander project validation.'
    )
  }
  assertWorkerLaunchPreferencesRuntimeSupported({
    model: params.model,
    effort: params.effort,
    capabilities,
    serverName
  })
  const supportsControlMail = capabilities?.includes(
    ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY
  )
  return supportsControlMail &&
    capabilities?.includes(ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY)
    ? ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION
    : supportsControlMail
      ? ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION
      : 1
}
