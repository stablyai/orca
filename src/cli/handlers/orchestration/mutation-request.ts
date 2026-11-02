import { randomUUID } from 'node:crypto'
import { RuntimeClientError, type RuntimeClient } from '../../runtime-client'
import { readRetryRequestFlag } from '../../retry-request-flag'
import { orchestrationMutationRecoveryError } from '../../orchestration-mutation-recovery'
import { isRequestUnsent } from '../../runtime/client-error-recovery'

const MAX_UNAVAILABLE_RETRY_DELAY_MS = 15_000

export async function callOrchestrationMutation<TResult>(
  client: RuntimeClient,
  flags: Map<string, string | boolean>,
  method: string,
  params: unknown,
  options?: { timeoutMs?: number; orchestrationCapability?: string },
  unavailableRetryMs = 0
) {
  // Reuse one request id so retries replay the mutation instead of applying it twice.
  const retryRequest = readRetryRequestFlag(flags)
  const requestId = retryRequest ?? (unavailableRetryMs > 0 ? randomUUID() : undefined)
  const deadline = Date.now() + unavailableRetryMs
  let sentError: RuntimeClientError | undefined
  for (let delayMs = 1_000; ; delayMs = Math.min(delayMs * 2, MAX_UNAVAILABLE_RETRY_DELAY_MS)) {
    try {
      return requestId
        ? await client.call<TResult>(method, params, {
            ...options,
            orchestrationRequestId: requestId
          })
        : options
          ? await client.call<TResult>(method, params, options)
          : await client.call<TResult>(method, params)
    } catch (error) {
      const unavailable =
        error instanceof RuntimeClientError && error.code === 'runtime_unavailable'
      const sent = carriesRequestId(error) && !isRequestUnsent(error)
      if (sent) {
        sentError = error
      }
      if (!unavailable || Date.now() + delayMs > deadline) {
        // A later failure may lack the request id even though an earlier attempt landed.
        throw orchestrationMutationRecoveryError(sent ? error : (sentError ?? error), {
          // Only a fresh id that never got past the contract check is known not to have run.
          unsent: !retryRequest && !sentError && isRequestUnsent(error)
        })
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}

function carriesRequestId(error: unknown): error is RuntimeClientError {
  const data: unknown = error instanceof RuntimeClientError ? error.data : undefined
  return (
    typeof data === 'object' &&
    data !== null &&
    'orchestrationRequestId' in data &&
    typeof data.orchestrationRequestId === 'string'
  )
}
