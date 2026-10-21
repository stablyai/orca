// How an acquisition that failed after spawn ended, as far as cleanup could prove it.

/**
 * The provider's own root process was observed to exit, but its descendant tree
 * was not proven gone. The lease keys on the root's pid and start time, so its
 * observed death releases the reservation; nothing is claimed about descendants,
 * including one seen still alive.
 */
export class AgentSessionAcquisitionRootExitObservedError extends Error {
  constructor(cause: unknown) {
    // The provider's own diagnostic is the only thing the user can act on.
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = 'AgentSessionAcquisitionRootExitObservedError'
  }
}

/** The provider child failed and cleanup proved its whole tree gone — on Windows, that its root
 *  left on its own after stdin end (descendants not addressed, as with Codex) or taskkill reported
 *  the tree terminated. As with a root exit, the provider's own diagnostic is the message. */
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
