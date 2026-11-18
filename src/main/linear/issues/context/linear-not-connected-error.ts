import { linearError, type LinearAgentAccessError } from './linear-access-errors'

// Each Orca host keeps its own Linear key, and a headless host has no Settings window to connect from.
export function linearNotConnectedError(retryAction?: string): LinearAgentAccessError {
  const retry = retryAction ? `, then retry the ${retryAction}` : ''
  return linearError('linear_not_connected', 'Linear is not connected on this Orca host.', {
    nextSteps: [
      `Connect Linear on this Orca host (in its Settings, or with \`orca linear connect\` aimed at this host)${retry}.`
    ]
  })
}
