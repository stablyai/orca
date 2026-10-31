import type { AutomationsChangedPayload } from '../../shared/runtime-client-events'
import type {
  AutomationAttentionDelivery,
  AutomationAttentionResult
} from '../runtime/automation-attention-correlations'
import type { AutomationDispatchResult } from '../../shared/automations-types'

export type AutomationResultPresentation = {
  assistantMessage?: string
  attention?: AutomationAttentionResult
}
/** Process-only result fields; persistence copies canonical run fields explicitly. */
export type AutomationRunResult = AutomationDispatchResult & {
  presentation?: AutomationResultPresentation
}

export type PublishAutomationOutcome = (
  payload: AutomationsChangedPayload,
  attention?: AutomationAttentionDelivery
) => void
