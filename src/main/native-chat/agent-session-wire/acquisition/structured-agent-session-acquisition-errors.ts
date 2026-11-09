/** Writer death evidence releases its reservation without claiming descendant termination. */
export class AgentSessionAcquisitionRootExitObservedError extends Error {
  constructor(
    cause: unknown,
    readonly deathEvidenceKind: 'exit-observed' | 'kill-delivered' = 'exit-observed'
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'AgentSessionAcquisitionRootExitObservedError'
  }
}

/** A root exit settled by delivering a kill, which the close must still report. */
export function isKillDeliveredRootExit(
  error: unknown
): error is AgentSessionAcquisitionRootExitObservedError {
  return (
    error instanceof AgentSessionAcquisitionRootExitObservedError &&
    error.deathEvidenceKind === 'kill-delivered'
  )
}

/** Cleanup proved exit: on Windows, graceful root exit or taskkill’s tree-termination report. */
export class AgentSessionAcquisitionExitProvenError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'AgentSessionAcquisitionExitProvenError'
  }
}

export class AgentSessionAcquisitionExitUnprovenError extends Error {
  constructor(cause: unknown) {
    super('agent_session_acquisition_exit_unproven', { cause })
    this.name = 'AgentSessionAcquisitionExitUnprovenError'
  }
}
