import { RuntimeClientError, RuntimeRpcFailureError } from '../runtime-client'

// Hosts use generic runtime_error here; this message is the stable discriminator.
const SETUP_DECISION_REQUIRED = 'Setup decision required for this repository'
const SETUP_DECISION_NEXT_STEP =
  'Pass --setup run to run the setup script, or --setup skip to create without it.'

/** Only the CLI answers setup prompts with --setup; desktop and mobile have their own UI. */
export async function withSetupDecisionRecovery<T>(
  create: Promise<T>,
  replayingLaunch = false
): Promise<T> {
  try {
    return await create
  } catch (error) {
    throw attachSetupDecisionRecovery(error, replayingLaunch)
  }
}

function attachSetupDecisionRecovery(error: unknown, replayingLaunch: boolean): unknown {
  if (!(error instanceof RuntimeClientError) || error.message !== SETUP_DECISION_REQUIRED) {
    return error
  }
  const data = {
    ...(error.data && typeof error.data === 'object' ? error.data : {}),
    nextSteps: [
      SETUP_DECISION_NEXT_STEP,
      ...(replayingLaunch && error instanceof RuntimeRpcFailureError
        ? [
            'This launch was refused before creation. Remove --retry-launch for the changed request so Orca uses a new launch ID.'
          ]
        : [])
    ]
  }
  if (error instanceof RuntimeRpcFailureError) {
    return new RuntimeRpcFailureError({
      ...error.response,
      error: { ...error.response.error, data }
    })
  }
  return new RuntimeClientError(error.code, error.message, data)
}
