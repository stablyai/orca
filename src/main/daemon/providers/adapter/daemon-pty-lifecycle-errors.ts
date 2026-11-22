export class FinalCheckpointWaitExpiredError extends Error {
  constructor(sessionId: string) {
    super(`Final history checkpoint did not settle within the teardown deadline: ${sessionId}`)
    this.name = 'FinalCheckpointWaitExpiredError'
  }
}

/** The final checkpoint pass settled but did not commit this session; the live terminal is kept. */
export class FinalCheckpointNotCommittedError extends Error {
  constructor(sessionId: string) {
    super(`Final history checkpoint was not committed for session: ${sessionId}`)
    this.name = 'FinalCheckpointNotCommittedError'
  }
}

export class TerminalKilledError extends Error {
  constructor(sessionId: string) {
    super(`Session "${sessionId}" was explicitly killed`)
    this.name = 'TerminalKilledError'
  }
}
