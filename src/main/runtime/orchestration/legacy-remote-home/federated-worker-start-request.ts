import type { RuntimeStatus } from '../../../../shared/remote-runtime/session-graph/runtime-session-contracts'
import {
  ORCHESTRATION_CONTRACT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION,
  ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION,
  ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY,
  ORCHESTRATION_FEDERATION_RUNTIME_CAPABILITY
} from '../../../../shared/orchestration/orchestration-runtime-capabilities'
import { orchestrationMigrationData } from '../../../../shared/orchestration/orchestration-rpc-contract'
import type { OrchestrationEntryCaller } from '../addressing/orchestration-caller-identity'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OrchestrationDb } from '../db/orchestration-db'
import type { WorkerStartInput } from '../../rpc/methods/orchestration/worker/start/worker-start-input'
import type { WorkerStartMutation } from '../../rpc/methods/orchestration/worker/start/worker-start-mutation'
import { OrchestrationError } from '../orchestration-error'
import type { ResolvedBotWorkTargetPlacement } from '../../../../shared/agent-session/work-target/agent-session-work-target'

export type FederatedWorkerStartRequest = {
  params: WorkerStartInput
  runtime: OrcaRuntimeService
  db: OrchestrationDb
  /** Called only once preflight passes, so a refused start binds no new Run. */
  bindRunId: () => string
  task?: { id: string; spec: string; status: string }
  taskDeps: string[] | undefined
  orchestrationMutation?: WorkerStartMutation
  /** The coordinator's resolved session, when it is one; recorded as the Dispatch creator. */
  callerSession?: OrchestrationEntryCaller
  /** Validated single-turn bot work target pinning pairing revision and top-level lineage. */
  workTarget?: ResolvedBotWorkTargetPlacement
}

/** Verify contract + federation capabilities on a legacy remote server and pick its protocol version. */
export function resolveFederatedServerProtocolVersion(
  status: RuntimeStatus,
  serverName: string
): number {
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
  const supportsControlMail = status.capabilities.includes(
    ORCHESTRATION_FEDERATION_CONTROL_MAIL_RUNTIME_CAPABILITY
  )
  return supportsControlMail &&
    status.capabilities.includes(ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_RUNTIME_CAPABILITY)
    ? ORCHESTRATION_FEDERATION_LIFECYCLE_SETTLEMENT_PROTOCOL_VERSION
    : supportsControlMail
      ? ORCHESTRATION_FEDERATION_CONTROL_MAIL_PROTOCOL_VERSION
      : 1
}
