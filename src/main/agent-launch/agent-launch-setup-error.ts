import { OrchestrationError } from '../runtime/orchestration/orchestration-error'

export const AGENT_LAUNCH_SETUP_FAILURE_CODES = [
  'agent_setup_failed',
  'agent_setup_unconfirmed',
  'agent_setup_timeout'
] as const

export class AgentLaunchSetupError extends OrchestrationError {
  constructor(code: (typeof AGENT_LAUNCH_SETUP_FAILURE_CODES)[number], message: string) {
    super(code, message)
  }
}
