import { randomUUID } from 'node:crypto'
import { RuntimeClientError } from '../../runtime/connection/types'
import type { RuntimeClient } from '../../runtime/client'
import { readRetryRequestFlag } from './retry-request-flag'
import { orchestrationMutationRecoveryError } from './orchestration-mutation-recovery'
import { isRequestUnsent } from '../../runtime/connection/client-error-recovery'
import { RETRY_RECEIPT_ABSENT_CODE } from '../../../shared/orchestration/orchestration-retry-request-id'

const MAX_RETRY_DELAY_MS = 15_000
// The same request id replays a committed mutation or joins one still running, so these are safe to resend.
const KEYED_RETRY_CODES = new Set(['runtime_unavailable', 'runtime_timeout'])

export async function callOrchestrationMutation<TResult>(
  client: RuntimeClient,
  flags: Map<string, string | boolean>,
  method: string,
  params: unknown,
  options?: { timeoutMs?: number; orchestrationCapability?: string },
  retryBudgetMs = 0
) {
  // Reuse one request id so retries replay the mutation instead of applying it twice.
  const retryRequest = readRetryRequestFlag(flags)
  const requestId = retryRequest ?? (retryBudgetMs > 0 ? randomUUID() : undefined)
  const deadline = Date.now() + retryBudgetMs
  let sentError: RuntimeClientError | undefined
  // Once a timeout may have reached the runtime, only a replay or join of that attempt is safe.
  let retryAfterTimeout = false
  for (let delayMs = 1_000; ; delayMs = Math.min(delayMs * 2, MAX_RETRY_DELAY_MS)) {
    try {
      return requestId
        ? await client.call<TResult>(method, params, {
            ...options,
            orchestrationRequestId: requestId,
            ...(retryAfterTimeout ? { orchestrationRetryAfterTimeout: true as const } : {})
          })
        : options
          ? await client.call<TResult>(method, params, options)
          : await client.call<TResult>(method, params)
    } catch (error) {
      const retryable = error instanceof RuntimeClientError && KEYED_RETRY_CODES.has(error.code)
      // The runtime refused to run a retry whose receipt is gone; report the earlier timeout instead.
      const receiptAbsent =
        retryAfterTimeout &&
        error instanceof RuntimeClientError &&
        error.code === RETRY_RECEIPT_ABSENT_CODE
      const sent = !receiptAbsent && carriesRequestId(error) && !isRequestUnsent(error)
      if (sent) {
        sentError = error
        retryAfterTimeout ||= error.code === 'runtime_timeout'
      }
      // Callers without a budget never retry, even if the wall clock steps backward.
      if (!retryable || retryBudgetMs <= 0 || Date.now() + delayMs > deadline) {
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
