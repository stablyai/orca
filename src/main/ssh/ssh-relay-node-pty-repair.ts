/**
 * Turning a spawn-time "remote terminals are unavailable" into an actual repair.
 *
 * The fault is proved on the relay at spawn time; the only thing that can fix it —
 * `repairInstalledNativeDeps` in ssh-relay-deploy.ts — runs on the client during deploy, under
 * `tryAcquireRelayRepairLock`. So the recovery here is deliberately indirect: it does not touch
 * the remote `node_modules` itself, it drives one relay reconnect and lets the locked deploy path
 * do the rebuild. All `node_modules` mutation stays behind that lock.
 *
 * The invariant that matters more than the recovery: **at most one repair per host per reason.**
 * A rebuild loop against a remote is worse than the bug it is chasing, so the attempt is recorded
 * before the reconnect starts, not after it succeeds. A repair that ran and failed is still an
 * attempt, and this host will render the relay's message from then on.
 */
import {
  mayRepairFromCause,
  type TerminalUnavailableCause
} from '../../shared/terminal-unavailable-cause'

/** targetId -> the cause reasons already spent on this host, for the life of the session. */
const attemptedRepairsByTarget = new Map<string, Set<string>>()

export type RelayNodePtyRepairOutcome =
  /** The cause is not proved-and-rebuildable; render the relay's message. */
  | 'not-repairable'
  /** This host already spent its one attempt on this reason. */
  | 'already-attempted'
  /** The relay is still serving PTYs, so a rebuild under it is not accounted for. */
  | 'ptys-live'
  /** No reconnect was possible, or it failed; the attempt is still spent. */
  | 'reconnect-failed'
  /** Reconnected, but no provider came back to retry on. */
  | 'no-provider'
  | 'repaired'

/** Forget a host's spent attempts. Disconnect is user action, so it may earn a fresh one. */
export function forgetRelayNodePtyRepairs(targetId: string): void {
  attemptedRepairsByTarget.delete(targetId)
}

/** Test/diagnostic view of the ledger. */
export function relayNodePtyRepairAttempts(targetId: string): ReadonlySet<string> {
  return attemptedRepairsByTarget.get(targetId) ?? new Set<string>()
}

/** False when this host has already spent its attempt on this reason. Marks on success. */
function claimRepairAttempt(targetId: string, reason: string): boolean {
  const spent = attemptedRepairsByTarget.get(targetId)
  if (spent) {
    if (spent.has(reason)) {
      return false
    }
    spent.add(reason)
    return true
  }
  attemptedRepairsByTarget.set(targetId, new Set([reason]))
  return true
}

export type RelayNodePtyRepairRequest<TProvider> = {
  targetId: string
  /** Already parsed and schema-validated; null when the relay published no cause. */
  cause: TerminalUnavailableCause | null
  /** Whether this client still holds live PTYs on the relay about to be rebuilt. */
  hasLivePtys: () => boolean
  /** One relay reconnect, which runs the locked `repairInstalledNativeDeps`. */
  reconnect: () => Promise<void>
  /** The provider registered after the reconnect — never the one that failed. */
  resolveProvider: () => TProvider | null
}

/**
 * Drive one repair for a failed spawn, returning the provider to retry on.
 *
 * Gates on `mayRepairFromCause`, not on the peer's `repairable` flag: an `unverifiable` cause
 * proves nothing and must never trigger a rebuild (#14830, docs/reference/ssh-execution-boundary.md).
 */
export async function recoverRelayNodePtyForSpawn<TProvider>(
  request: RelayNodePtyRepairRequest<TProvider>
): Promise<{ outcome: RelayNodePtyRepairOutcome; provider: TProvider | null }> {
  const { targetId, cause } = request
  if (!mayRepairFromCause(cause) || !cause) {
    return { outcome: 'not-repairable', provider: null }
  }
  // Why check before claiming: a live PTY means the rebuild's blast radius is unaccounted for, and
  // that is a reason to wait, not a spent attempt. Costs nothing remote, so it cannot loop.
  if (request.hasLivePtys()) {
    console.warn(
      `[ssh-relay-repair] Not rebuilding node-pty on ${targetId} for ${cause.reason}: the relay is still serving PTYs`
    )
    return { outcome: 'ptys-live', provider: null }
  }
  if (!claimRepairAttempt(targetId, cause.reason)) {
    console.warn(
      `[ssh-relay-repair] node-pty repair for ${cause.reason} on ${targetId} already ran; not retrying`
    )
    return { outcome: 'already-attempted', provider: null }
  }

  console.warn(
    `[ssh-relay-repair] Reconnecting ${targetId} once to rebuild node-pty (${cause.reason}): ${cause.detail}`
  )
  try {
    await request.reconnect()
  } catch (error) {
    console.warn(
      `[ssh-relay-repair] Repair reconnect for ${targetId} failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
    return { outcome: 'reconnect-failed', provider: null }
  }
  const provider = request.resolveProvider()
  return provider ? { outcome: 'repaired', provider } : { outcome: 'no-provider', provider: null }
}
