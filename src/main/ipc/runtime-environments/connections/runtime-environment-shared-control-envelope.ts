import { isOrchestrationMutation } from '../../../../shared/orchestration/orchestration-rpc-contract'
import type { RuntimeOrchestrationEnvelope } from '../../../../shared/runtime-rpc-envelope'

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
