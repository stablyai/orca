import { ORCHESTRATION_PROMPT_SUBMIT_VERIFICATION_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { OrchestrationError } from '../../orchestration/orchestration-error'

export function assertPromptSubmitVerificationSupported(
  capabilities: readonly string[] | undefined,
  serverName: string
): void {
  if (capabilities?.includes(ORCHESTRATION_PROMPT_SUBMIT_VERIFICATION_RUNTIME_CAPABILITY)) {
    return
  }
  throw new OrchestrationError(
    'capability_unsupported',
    `Connected server ${serverName} cannot verify worker prompt submission. No effects were applied.`
  )
}
