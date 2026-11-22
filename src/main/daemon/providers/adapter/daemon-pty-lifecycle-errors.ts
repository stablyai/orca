export class FinalCheckpointWaitExpiredError extends Error {
  constructor(sessionId: string) {
    super(`Final history checkpoint did not settle within the teardown deadline: ${sessionId}`)
    this.name = 'FinalCheckpointWaitExpiredError'
  }
}

export class FinalCheckpointPreservationError extends Error {
  constructor(sessionId: string) {
    super(`Final history checkpoint did not preserve the terminal's screen: ${sessionId}`)
    this.name = 'FinalCheckpointPreservationError'
  }
}

export class TerminalKilledError extends Error {
  constructor(sessionId: string) {
    super(`Session "${sessionId}" was explicitly killed`)
    this.name = 'TerminalKilledError'
  }
}
