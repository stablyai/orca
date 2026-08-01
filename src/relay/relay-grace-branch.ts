/** Which rule decided the current relay grace window. */
export type RelayGraceBranch =
  | 'shutdown-deferred'
  | 'startup-empty-detached'
  | 'idle-no-ptys'
  | 'configured'

export type RelayGraceDecisionInput = {
  /** The live configured grace, not the launch-time argv value; 0 means unlimited. */
  configuredGraceMs: number
  /** Zero pooled PTYs *and* zero admitted-but-unpooled creations. */
  relayIdle: boolean
  detached: boolean
  hasAcceptedSocketClient: boolean
  activePtyCount: number
  retryDeferredShutdown: boolean
  emptyDetachedStartupGraceMs: number
  idleRelayGraceMs: number
}

export type RelayGraceDecision = {
  branch: RelayGraceBranch
  timeoutMs: number
}

/**
 * Picks the relay's shutdown grace window.
 *
 * Why a separate module: relay.ts runs `main()` on import and exports nothing, so the zero-only
 * gate below — the property that keeps a configured grace from being clamped to the idle cap —
 * could not otherwise be tested.
 */
export function decideRelayGrace(input: RelayGraceDecisionInput): RelayGraceDecision {
  // Why: a detached relay that never accepted a client has no PTY state and shouldn't linger forever.
  const startupEmptyDetached =
    input.detached && !input.hasAcceptedSocketClient && input.activePtyCount === 0
  // Why: zero PTYs means nothing left to preserve, so only the unlimited default is capped — an
  // explicitly configured grace is honored verbatim rather than clamped down to the idle cap.
  // Why: a spawn parked mid-creation is not in the pool yet, so capping on it would kill the live
  // shell it is about to produce.
  const idleNoPtys = input.relayIdle && input.configuredGraceMs === 0

  const branch: RelayGraceBranch = input.retryDeferredShutdown
    ? 'shutdown-deferred'
    : startupEmptyDetached
      ? 'startup-empty-detached'
      : idleNoPtys
        ? 'idle-no-ptys'
        : 'configured'

  const timeoutMs =
    branch === 'startup-empty-detached'
      ? input.configuredGraceMs === 0
        ? input.emptyDetachedStartupGraceMs
        : Math.min(input.configuredGraceMs, input.emptyDetachedStartupGraceMs)
      : // Why: a refused kill leaves the PTY pooled, so the idle branch can't be reached — this
        // branch must supply its own bound or the shipped grace=0 default arms no retry at all.
        branch === 'idle-no-ptys' || branch === 'shutdown-deferred'
        ? input.idleRelayGraceMs
        : input.configuredGraceMs

  return { branch, timeoutMs }
}
