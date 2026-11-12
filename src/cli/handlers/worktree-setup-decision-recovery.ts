import { getPresentStringFlag } from '../flags'
import { RuntimeClientError, RuntimeRpcFailureError } from '../runtime/types'

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
  return attachCliErrorData(error, data)
}

export function attachCliErrorData(error: RuntimeClientError, data: unknown): RuntimeClientError {
  if (error instanceof RuntimeRpcFailureError) {
    return new RuntimeRpcFailureError({
      ...error.response,
      error: { ...error.response.error, data }
    })
  }
  return new RuntimeClientError(error.code, error.message, data)
}

/** --setup's value, refusing a contradiction with --run-hooks. */
export function getOptionalSetupDecision(
  flags: Map<string, string | boolean>
): 'run' | 'skip' | 'inherit' | undefined {
  const setup = getPresentStringFlag(flags, 'setup')
  if (setup !== undefined && setup !== 'run' && setup !== 'skip' && setup !== 'inherit') {
    throw new RuntimeClientError('invalid_argument', '--setup must be one of: run, skip, inherit')
  }
  if (flags.get('run-hooks') === true && setup !== undefined && setup !== 'run') {
    throw new RuntimeClientError(
      'invalid_argument',
      'Choose either --run-hooks or --setup run, not contradictory setup flags.'
    )
  }
  return setup
}
