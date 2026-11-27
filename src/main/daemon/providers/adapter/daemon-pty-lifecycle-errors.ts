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

/**
 * A degraded Sleep had no recoverable history to wake from (detectColdRestoreState
 * was not "restored", or there is no history reader). Killing would destroy the
 * terminal with nothing left to restore, so the live PTY is kept.
 */
export class DegradedRestoreUnavailableError extends Error {
  constructor(sessionId: string) {
    super(`Sleep degraded path has no recoverable checkpoint for session: ${sessionId}`)
    this.name = 'DegradedRestoreUnavailableError'
  }
}

/** A degraded Sleep may kill only when a committed checkpoint can be woken from. */
export function assertDegradedRestoreAvailable(
  sessionId: string,
  preservation: { degraded: boolean },
  detected: unknown
): void {
  if (preservation.degraded && !detected) {
    throw new DegradedRestoreUnavailableError(sessionId)
  }
}

export class TerminalKilledError extends Error {
  constructor(sessionId: string) {
    super(`Session "${sessionId}" was explicitly killed`)
    this.name = 'TerminalKilledError'
  }
}
