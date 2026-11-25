import { randomUUID } from 'node:crypto'
import { RuntimeClientError } from '../../runtime/connection/types'
import type { RuntimeClient } from '../../runtime/client'
import { readRetryRequestFlag } from './retry-request-flag'
import { orchestrationMutationRecoveryError } from './orchestration-mutation-recovery'
import { isRequestUnsent } from '../../runtime/connection/client-error-recovery'

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
  // A monotonic clock, so a wall-clock step neither stretches nor cuts the budget.
  const deadline = performance.now() + retryBudgetMs
  let sentError: RuntimeClientError | undefined
  // A timeout after sending may have committed; until a reply settles it, it is the outcome to report,
  // and every retry is replay-only so the runtime can replay or join it but never run it again.
  let sentTimeout: RuntimeClientError | undefined
  for (let delayMs = 1_000; ; delayMs = Math.min(delayMs * 2, MAX_RETRY_DELAY_MS)) {
    try {
      return requestId
        ? await client.call<TResult>(method, params, {
            ...options,
            orchestrationRequestId: requestId,
            ...(sentTimeout ? { orchestrationReplayOnly: true as const } : {})
          })
        : options
          ? await client.call<TResult>(method, params, options)
          : await client.call<TResult>(method, params)
    } catch (error) {
      const retryable = error instanceof RuntimeClientError && KEYED_RETRY_CODES.has(error.code)
      const sent = carriesRequestId(error) && !isRequestUnsent(error)
      if (sent) {
        sentError = error
        if (error.code === 'runtime_timeout') {
          sentTimeout ??= error
        }
      }
      // Callers without a budget never retry, even if the wall clock steps backward.
      if (!retryable || retryBudgetMs <= 0 || performance.now() + delayMs > deadline) {
        // A later refusal or failure covers only its own attempt, never the possibly committed timeout.
        throw orchestrationMutationRecoveryError(
          sentTimeout ?? (sent ? error : (sentError ?? error)),
          {
            // Only a fresh id that never got past the contract check is known not to have run.
            unsent: !retryRequest && !sentError && isRequestUnsent(error)
          }
        )
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
