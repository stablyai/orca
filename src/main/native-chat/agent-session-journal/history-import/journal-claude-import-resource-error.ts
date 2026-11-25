import {
  AgentSessionRefusalError,
  refuse
} from '../../../../shared/agent-session/failures/agent-session-wire-refusals'

/** A bounded import could not verify or prepare history. The same source can be retried. */
export class ClaudeImportResourceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ClaudeImportResourceError'
  }
}

/** The writer rolled back because the staged import's source witness moved. */
export class ClaudeImportVersionChangedError extends AgentSessionRefusalError {
  constructor() {
    super(
      refuse(
        'agent_session_identity_required',
        { reason: 'transcriptUnreadable' },
        'Claude transcript changed during history import.'
      )
    )
    this.name = 'ClaudeImportVersionChangedError'
  }
}
