import { OrchestrationError } from '../../orchestration/orchestration-error'
import {
  OPENCODE_MODEL_TRANSPORT_REFUSAL,
  OPENCODE_MODEL_CONFIG_REFUSAL,
  OPENCODE_MODEL_VERSION_REFUSAL
} from '../../../../shared/agent-launch/choices/agent-launch-model-preferences'
import { prepareOpenCodeModelStartupInputs } from '../../../opencode/opencode-model-startup-plan'

export async function prepareWorktreeModelStartupInputs(
  options: Parameters<typeof prepareOpenCodeModelStartupInputs>[0]
): ReturnType<typeof prepareOpenCodeModelStartupInputs> {
  try {
    return await prepareOpenCodeModelStartupInputs(options)
  } catch (error) {
    // Compilation precedes creation: retain the legacy recipe here without repeating the plugin hook or RPC.
    if (
      !options.signal?.aborted &&
      error instanceof OrchestrationError &&
      error.code === 'capability_unsupported' &&
      [
        OPENCODE_MODEL_TRANSPORT_REFUSAL,
        OPENCODE_MODEL_CONFIG_REFUSAL,
        OPENCODE_MODEL_VERSION_REFUSAL
      ].includes(error.message)
    ) {
      return { inputs: options.inputs }
    }
    throw error
  }
}
