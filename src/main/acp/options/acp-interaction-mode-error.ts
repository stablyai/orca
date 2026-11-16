import { AgentSessionOptionRejectedError } from '../../native-chat/agent-session-wire/options/structured-agent-session-option-error'
import {
  agentSessionFailureFact,
  providerDiagnosticOf,
  type AgentSessionFailureFact
} from '../../../shared/agent-session/failures/agent-session-failure'

export function acpInteractionModeError(
  value: string,
  problem: NonNullable<AgentSessionFailureFact['interactionMode']>['problem'],
  cause?: unknown
): AgentSessionOptionRejectedError {
  return new AgentSessionOptionRejectedError(
    cause ?? `The ${value === 'default' ? 'Build' : 'Plan'} agent is ${problem}`,
    'optionRejected',
    agentSessionFailureFact('interactionModeFailed', {
      interactionMode: { mode: value === 'default' ? 'default' : 'plan', problem },
      detail: providerDiagnosticOf(cause)
    })
  )
}
