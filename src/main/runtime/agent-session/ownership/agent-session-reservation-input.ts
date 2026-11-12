import {
  isAgentSessionLaunchEnv,
  isAgentSessionOptions
} from '../../../../shared/agent-session/lifecycle/agent-session-record'
import { isAgentSessionLaunchArgs } from '../../../../shared/agent-session/lifecycle/agent-session-launch-args'
import { validateAdvisoryReservationInput } from './agent-session-advisory-reservation'
import { validateExecutionReservationInput } from './agent-session-execution-reservation'
import type { AgentSessionReserveRequest } from './agent-session-reservation-admission'

export function validateAgentSessionReservationInput(request: AgentSessionReserveRequest): void {
  validateAdvisoryReservationInput(request)
  validateExecutionReservationInput(request)
  if (request.launchEnv && !isAgentSessionLaunchEnv(request.launchEnv)) {
    throw new Error('agent_session_launch_env_invalid')
  }
  if (request.launchArgs && !isAgentSessionLaunchArgs(request.launchArgs)) {
    throw new Error('agent_session_launch_args_invalid')
  }
  if (request.options && !isAgentSessionOptions(request.options)) {
    throw new Error('agent_session_options_invalid')
  }
}
