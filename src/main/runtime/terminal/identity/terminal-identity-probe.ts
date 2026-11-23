/** Probe orchestration identity without inventing writable PTY facts for structured workers.
 * PTY identities retain terminal.show's rendererGraphEpoch leaf check so old shell handles fail after window reload. */

export type RuntimeTerminalIdentity = {
  handle: string
  live: boolean
}

/** The one error code that means "not live" rather than "could not look". */
export const TERMINAL_HANDLE_STALE_ERROR = 'terminal_handle_stale'

export type TerminalIdentityProbes = {
  /** A structured worker of THIS runtime, proven through its durable record. */
  isLiveStructuredWorker: () => boolean
  hasLivePty: () => boolean
  /** Recheck the leaf/graph epoch and reject stale or reloaded handles. */
  assertLiveLeaf: () => void
}

export function resolveTerminalIdentityFromProbes(
  handle: string,
  probes: TerminalIdentityProbes
): RuntimeTerminalIdentity {
  if (probes.isLiveStructuredWorker() || probes.hasLivePty()) {
    return { handle, live: true }
  }
  try {
    probes.assertLiveLeaf()
    return { handle, live: true }
  } catch (error) {
    if (error instanceof Error && error.message === TERMINAL_HANDLE_STALE_ERROR) {
      return { handle, live: false }
    }
    // Graph-not-ready and other observation failures propagate; only terminal_handle_stale proves not live.
    throw error
  }
}
