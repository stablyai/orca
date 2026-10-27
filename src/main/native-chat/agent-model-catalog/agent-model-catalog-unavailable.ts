import type { AgentSessionUnavailable } from '../../../shared/agent-session-availability'

export class AgentModelCatalogUnavailableError extends Error {
  constructor(readonly unavailable: AgentSessionUnavailable) {
    super(
      unavailable.reason === 'cliMissing'
        ? 'the agent CLI is not installed'
        : 'the agent is not signed in for this account'
    )
    this.name = 'AgentModelCatalogUnavailableError'
  }
}
