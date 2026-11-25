import type { RuntimeOrchestrationEnvelope } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import { ORCHESTRATION_CONTRACT_VERSION } from '../../../shared/orchestration/orchestration-runtime-capabilities'
import type { RuntimeCallOptions } from './types'

/** The orchestration fields a runtime request carries, over the local socket or to a paired host. */
export function buildRuntimeRequestEnvelope(
  method: string,
  options: RuntimeCallOptions | undefined,
  orchestrationRequestId: string | undefined,
  compatibilityEnvelope: RuntimeOrchestrationEnvelope
): RuntimeOrchestrationEnvelope {
  return {
    orchestrationCapability: options?.orchestrationCapability,
    orchestrationContractVersion: method.startsWith('orchestration.')
      ? ORCHESTRATION_CONTRACT_VERSION
      : undefined,
    orchestrationRequestId,
    orchestrationRetryAfterTimeout: options?.orchestrationRetryAfterTimeout,
    ...compatibilityEnvelope
  }
}
