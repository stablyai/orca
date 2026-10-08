import { RuntimeClientError, RuntimeRpcFailureError } from '../runtime-client'

// Why match the text: every host version refuses an undecided `ask` create with exactly this
// message and the generic runtime_error code, so it is the only stable signal.
const SETUP_DECISION_REQUIRED = 'Setup decision required for this repository'
const SETUP_DECISION_NEXT_STEP =
  'Pass --setup run to run the setup script, or --setup skip to create without it.'

/** Why here, not on the host: desktop and phone choose setup in their own UI, so the host's
 *  shared refusal names no flag; only the CLI user answers it with --setup. */
export async function withSetupDecisionRecovery<T>(create: Promise<T>): Promise<T> {
  try {
    return await create
  } catch (error) {
    throw attachSetupDecisionRecovery(error)
  }
}

function attachSetupDecisionRecovery(error: unknown): unknown {
  if (!(error instanceof RuntimeClientError) || error.message !== SETUP_DECISION_REQUIRED) {
    return error
  }
  const data = {
    ...(error.data && typeof error.data === 'object' ? error.data : {}),
    nextSteps: [SETUP_DECISION_NEXT_STEP]
  }
  if (error instanceof RuntimeRpcFailureError) {
    return new RuntimeRpcFailureError({
      ...error.response,
      error: { ...error.response.error, data }
    })
  }
  return new RuntimeClientError(error.code, error.message, data)
}
