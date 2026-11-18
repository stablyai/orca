import { agentSessionStartFailure } from '../native-chat/agent-session-wire/startup/structured-agent-session-start-failure'
import { TraexRequestError } from './traex-protocol'

export function traexStartFailure(error: unknown, exited = false) {
  return agentSessionStartFailure(
    error,
    (cause) => (cause instanceof TraexRequestError ? 'final' : undefined),
    exited
  )
}
