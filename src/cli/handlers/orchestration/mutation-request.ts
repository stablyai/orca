import type { RuntimeClient } from '../../runtime-client'
import { getOptionalStringFlag } from '../../flags'
import { orchestrationMutationRecoveryError } from '../../orchestration-mutation-recovery'

export function callOrchestrationMutation<TResult>(
  client: RuntimeClient,
  flags: Map<string, string | boolean>,
  method: string,
  params: unknown,
  options?: { timeoutMs?: number; orchestrationCapability?: string }
) {
  const requestId = getOptionalStringFlag(flags, 'retry-request')
  const result = requestId
    ? client.call<TResult>(method, params, { ...options, orchestrationRequestId: requestId })
    : options
      ? client.call<TResult>(method, params, options)
      : client.call<TResult>(method, params)
  return result.catch((error) => {
    throw orchestrationMutationRecoveryError(error)
  })
}
