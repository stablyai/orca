import { RuntimeClientError, RuntimeRpcFailureError } from '../runtime-client'
import { stripMutationResponseLossRetryAdvice } from '../mutation-response-loss-message'

const REMOVE_RESPONSE_LOSS_STEPS = [
  'Run: orca worktree list --json and verify whether the workspace is absent.',
  'If it is absent, do not retry; the removal completed.',
  'If it remains, wait for the in-flight removal to settle before retrying.'
]

export function addWorktreeRemoveResponseRecovery(error: unknown): unknown {
  if (!(error instanceof RuntimeClientError) || !wasWorktreeRemoveSent(error.data)) {
    return error
  }
  const data = {
    ...(error.data as Record<string, unknown>),
    mutationMayHaveCompleted: true,
    nextSteps: REMOVE_RESPONSE_LOSS_STEPS
  }
  const message = `${stripMutationResponseLossRetryAdvice(error.message)} The workspace removal may still complete; verify state before retrying.`
  if (error instanceof RuntimeRpcFailureError) {
    return new RuntimeRpcFailureError({
      ...error.response,
      error: { ...error.response.error, message, data }
    })
  }
  return new RuntimeClientError(error.code, message, data)
}

function wasWorktreeRemoveSent(data: unknown): boolean {
  return (
    data !== null &&
    typeof data === 'object' &&
    (data as { requestPhase?: unknown }).requestPhase === 'awaiting_response' &&
    (data as { method?: unknown }).method === 'worktree.rm'
  )
}
