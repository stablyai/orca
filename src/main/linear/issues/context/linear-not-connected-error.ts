import { linearError, type LinearAgentAccessError } from './linear-access-errors'

// Neither an API key nor Connect Linear's login: the one line an agent passes on.
export function linearNotConnectedError(): LinearAgentAccessError {
  return linearError('linear_not_connected', 'Linear is not signed in on this computer.', {
    nextSteps: [
      'Connect Linear to your bot (or add a Linear API key in Settings › Integrations), then retry.'
    ]
  })
}
