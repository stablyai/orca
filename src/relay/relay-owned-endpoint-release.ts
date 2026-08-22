// The order in which a relay gives up its endpoint, extracted so it can be asserted.
//
// relay.ts runs main() on import and exports nothing, so this sequence is otherwise only observable
// by racing two real processes — which is exactly the race it exists to prevent.

export type OwnedEndpointRelease = {
  /** Re-checked immediately: a path this process no longer holds must not be touched at all. */
  ownsPath: () => boolean
  /** Null when this generation published no manifest (no `--owner-token`). */
  removeManifest: (() => void) | null
  /** Null on paths that release the socket without a listening server (uncaught exception). */
  closeServer: (() => void) | null
  unlinkSocket: () => void
}

/**
 * Releases this generation's endpoint, manifest first.
 *
 * Why that order: a bound socket is what excludes a successor. `server.close()` unlinks the listen
 * path synchronously, so the moment it returns another relay can bind the name and publish its own
 * manifest — and a removal issued after that can only delete the successor's file. Taking the
 * manifest down while the socket is still bound makes a successor impossible rather than merely
 * unlikely, which is what closes the read-then-unlink gap in the removal itself.
 *
 * Returns whether anything was released, so the caller can drop ownership and make later calls
 * no-ops.
 */
export function releaseOwnedEndpoint(steps: OwnedEndpointRelease): boolean {
  if (!steps.ownsPath()) {
    return false
  }
  try {
    steps.removeManifest?.()
  } catch {
    // Why: the manifest is best-effort litter control. Failing to remove it must never strand the
    // socket, which is the artifact that actually blocks the next relay.
  }
  steps.closeServer?.()
  // Why: re-check. closing the server unlinks the listen path synchronously, so by here a successor
  // may already have bound the name — and the unlink below compares nothing. Without this the
  // shutdown path deletes a live successor's socket, which is #8585 again.
  if (steps.ownsPath()) {
    steps.unlinkSocket()
  }
  return true
}
