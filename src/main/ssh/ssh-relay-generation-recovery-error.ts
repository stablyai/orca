// Why a relay recovery refusal is what it is, and whether retrying can change it.
//
// Split from ssh-relay-generation-reap so the classification — which decides whether a session keeps
// its reconnect backoff or gets parked with a message — can be read and changed on its own.

export type RelayGenerationRecoveryReason =
  | 'recovery-busy'
  | 'owner-unknown'
  | 'owner-unverifiable'
  | 'owner-in-transition'
  | 'owner-indeterminate'
  | 'endpoint-unusable'
  | 'probe-failed'
  | 'identity-mismatch'
  | 'identity-unverifiable'
  | 'termination-failed'
  | 'still-running'
  | 'relaunch-blocked'

const RECOVERY_ADVICE: Record<RelayGenerationRecoveryReason, string> = {
  'recovery-busy': 'another Orca client is already recovering this relay; retry shortly',
  'owner-unknown':
    'it was launched by an older Orca that publishes no owner manifest, so the process holding it cannot be identified',
  'owner-unverifiable': 'its owner manifest could not be read and trusted',
  'owner-in-transition':
    'ownership of the socket moved while Orca was reading it, so the process holding it now is a relay Orca did not set out to reclaim',
  'owner-indeterminate': 'the ownership probe answered with output Orca could not read',
  'endpoint-unusable': 'the endpoint path is occupied by something that is not a socket',
  'probe-failed': 'the remote host did not answer the ownership probe',
  'identity-mismatch': 'the recorded process is no longer that relay generation',
  'identity-unverifiable': 'the recorded process state could not be determined',
  'termination-failed': 'the termination request could not be confirmed',
  'still-running': 'the relay did not exit after SIGTERM',
  'relaunch-blocked': 'something still occupies the socket path after the old relay exited'
}

// Why: the message must not claim the relay is untouched once a SIGTERM has already landed — and a
// lost terminate reply is indistinguishable from a delivered signal, so it counts too.
const SIGNALLED_REASONS = new Set<RelayGenerationRecoveryReason>([
  'still-running',
  'relaunch-blocked',
  'termination-failed'
])

export class RelayGenerationRecoveryError extends Error {
  readonly reason: RelayGenerationRecoveryReason
  readonly sockPath: string

  constructor(reason: RelayGenerationRecoveryReason, sockPath: string, cause?: unknown) {
    const aftermath = SIGNALLED_REASONS.has(reason)
      ? 'Orca did not remove the socket or start a replacement.'
      : 'Orca left the existing relay and its PTYs untouched.'
    super(
      `Refusing to reclaim the relay socket at ${sockPath}: ${RECOVERY_ADVICE[reason]}. ${aftermath} Reset the relay for this host from SSH settings, or wait for the idle relay grace period to drain it.`,
      cause === undefined ? undefined : { cause }
    )
    this.name = 'RelayGenerationRecoveryError'
    this.reason = reason
    this.sockPath = sockPath
  }
}

// Why: only a refusal that re-running cannot change belongs here. A transport fault, a peer holding
// the lock, a relay still draining, or a successor that already took the socket are all states the
// existing reconnect backoff resolves — treating them as terminal would park a healthy session on
// one timed-out probe.
const TERMINAL_RECOVERY_REASONS = new Set<RelayGenerationRecoveryReason>([
  'owner-unknown',
  'owner-unverifiable',
  'endpoint-unusable',
  'identity-mismatch'
])

/**
 * True for a recovery refusal no amount of reconnect backoff can resolve, so the session layer can
 * surface the message instead of looping.
 */
export function isTerminalRelayGenerationRecoveryError(
  error: unknown
): error is RelayGenerationRecoveryError {
  return (
    error instanceof RelayGenerationRecoveryError && TERMINAL_RECOVERY_REASONS.has(error.reason)
  )
}
