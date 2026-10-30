import type { PreparedAgentLaunchIdentity } from '../../../../shared/prepared-agent-launch'

/** A detached subscriber does not own cancellation of accepted work. */
export class PreparedTerminalPendingError extends Error {
  constructor(readonly pending: PreparedAgentLaunchIdentity) {
    super(
      'Setup or agent launch is still owned by the terminal host. Reconnect to observe its result.'
    )
  }
}
