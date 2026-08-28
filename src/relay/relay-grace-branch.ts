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

export type RelayGraceReconfigureInput = {
  previousConfiguredGraceMs: number
  nextConfiguredGraceMs: number
  /** A grace window with a real deadline is running; an unlimited (deadline-less) one is not re-armed. */
  graceTimerArmed: boolean
  shutdownInFlight: boolean
  currentBranch: RelayGraceBranch | null
}

export type RelayGraceReconfigureDecision =
  | { rearm: false }
  | { rearm: true; retryDeferredShutdown: boolean }

/** Live relay grace state, read through accessors so the caller's `let` bindings stay authoritative. */
export type RelayGraceTimeConfigurationInput = {
  readConfiguredGraceMs: () => number
  /** Writes the new grace; the value is read back so a normalizing setter wins. */
  writeConfiguredGraceMs: (graceMs: number) => void
  isGraceTimerArmed: () => boolean
  isShutdownInFlight: () => boolean
  readGraceBranch: () => RelayGraceBranch | null
  startGrace: (reason: string, options?: { retryDeferredShutdown?: boolean }) => void
}

/**
 * Applies a `relay.configureGraceTime` payload, re-arming the running window when the value changed.
 *
 * Why extracted from relay.ts: that file runs `main()` on import and exports nothing, so the call site
 * — including the `retryDeferredShutdown` hand-off into `startGrace` — is otherwise untestable.
 */
export function applyRelayGraceTimeConfiguration(
  graceTimeSeconds: unknown,
  state: RelayGraceTimeConfigurationInput
): { graceTimeMs: number } {
  const seconds = Number(graceTimeSeconds)
  if (Number.isFinite(seconds) && seconds >= 0) {
    const previousConfiguredGraceMs = state.readConfiguredGraceMs()
    // Why: the host sends 0 before system sleep so live remote PTYs survive longer than the ordinary grace window.
    state.writeConfiguredGraceMs(Math.floor(seconds) * 1000)
    const reconfigure = decideRelayGraceReconfigure({
      previousConfiguredGraceMs,
      nextConfiguredGraceMs: state.readConfiguredGraceMs(),
      graceTimerArmed: state.isGraceTimerArmed(),
      shutdownInFlight: state.isShutdownInFlight(),
      currentBranch: state.readGraceBranch()
    })
    if (reconfigure.rearm) {
      state.startGrace('grace reconfigured', {
        retryDeferredShutdown: reconfigure.retryDeferredShutdown
      })
    }
  }
  return { graceTimeMs: state.readConfiguredGraceMs() }
}

/**
 * Decides whether a live grace change must re-arm the running grace timer.
 *
 * Why a decision rather than inline gating: `startGrace` samples the configured grace at arm time, so
 * this gate is the only thing that makes a post-launch raise take effect on an already-running window.
 */
export function decideRelayGraceReconfigure(
  input: RelayGraceReconfigureInput
): RelayGraceReconfigureDecision {
  // Why only on an actual change: the host re-asserts the same value on every establish, and
  // restarting the window on those would keep a grace alive indefinitely.
  if (
    input.nextConfiguredGraceMs === input.previousConfiguredGraceMs ||
    !input.graceTimerArmed ||
    input.shutdownInFlight
  ) {
    return { rearm: false }
  }
  // Why carry the branch forward: re-arming without it downgrades a deferred shutdown to an ordinary
  // configured window, and the refused kill is never retried.
  return { rearm: true, retryDeferredShutdown: input.currentBranch === 'shutdown-deferred' }
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
