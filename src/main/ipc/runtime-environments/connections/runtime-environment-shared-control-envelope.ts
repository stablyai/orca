import { isOrchestrationMutation } from '../../../../shared/orchestration/orchestration-rpc-contract'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../../shared/orchestration/orchestration-runtime-capabilities'
import type { RuntimeOrchestrationEnvelope } from '../../../../shared/remote-runtime/rpc/runtime-rpc-envelope'

// Relay mutations safe on shared control: synchronous, idempotent by request id and cursor. Long-running ones (workerStart) stay one-shot for keepalive timeouts and host abort.
const SHARED_CONTROL_RELAY_MUTATIONS = [
  'orchestration.federationAck',
  'orchestration.federationImport'
]

export function shouldUseSharedControlEnvelope(
  method: string,
  params: unknown,
  envelope: RuntimeOrchestrationEnvelope | undefined
): RuntimeOrchestrationEnvelope | undefined {
  const sharedControlEligible =
    method.startsWith('orchestration.') &&
    (!isOrchestrationMutation(method, params) || SHARED_CONTROL_RELAY_MUTATIONS.includes(method))
  return envelope && sharedControlEligible ? envelope : undefined
}

/** The renderer ships with this main process, so its orchestration writes speak this contract. */
export function rendererOrchestrationEnvelope(
  method: string,
  params: unknown
): RuntimeOrchestrationEnvelope | undefined {
  return isOrchestrationMutation(method, params)
    ? { orchestrationContractVersion: ORCHESTRATION_CONTRACT_VERSION }
    : undefined
}
