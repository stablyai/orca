/**
 * Installed by the layer that owns a connection's relay health (today: the ephemeral-VM
 * runtime for runtime-owned targets). Consulted when an SSH operation arrives for a
 * connection with no registered provider, so the owner can re-attach the relay instead of
 * the lookup failing on the miss. Which targets to dial is the owner's policy; a recovery
 * returns undefined for connections it does not own.
 *
 * Kept dependency-free so the git and filesystem dispatchers can consult it without
 * pulling the PTY registry into their module graph.
 */
type SshProviderMissRecovery = (connectionId: string) => Promise<void> | undefined

let recovery: SshProviderMissRecovery | null = null

// Why throttled: git status and file watches poll; a miss per poll must not fan out into a
// re-attach per poll while one is already failing.
const BACKGROUND_RECOVERY_THROTTLE_MS = 5_000
const backgroundRecoveryStartedAt = new Map<string, number>()

export function setSshProviderMissRecovery(next: SshProviderMissRecovery | null): void {
  recovery = next
  backgroundRecoveryStartedAt.clear()
}

/** A promise only when a recovery is installed and claims the connection. */
export function recoverSshProviderMiss(connectionId: string): Promise<void> | undefined {
  return recovery?.(connectionId)
}

/**
 * Fire-and-forget re-attach for synchronous miss sites (git/filesystem `require*`). The
 * current call still fails; the caller's next poll or retry finds the provider registered.
 */
export function scheduleSshProviderMissRecovery(connectionId: string): void {
  if (!recovery) {
    return
  }
  const now = Date.now()
  const startedAt = backgroundRecoveryStartedAt.get(connectionId)
  if (startedAt !== undefined && now - startedAt < BACKGROUND_RECOVERY_THROTTLE_MS) {
    return
  }
  // Why prune before recording: an expired entry no longer throttles anything, and these
  // dispatchers are called with every SSH connection id in the app.
  for (const [id, at] of backgroundRecoveryStartedAt) {
    if (now - at >= BACKGROUND_RECOVERY_THROTTLE_MS) {
      backgroundRecoveryStartedAt.delete(id)
    }
  }
  const pending = recovery(connectionId)
  if (!pending) {
    // Declined: the owner does not claim this connection, so there is nothing to throttle
    // and recording it would retain an id this map will never act on.
    return
  }
  backgroundRecoveryStartedAt.set(connectionId, now)
  pending.catch((error: unknown) => {
    console.warn(
      `[ssh] Background provider re-attach failed for ${connectionId}: ${error instanceof Error ? error.message : String(error)}`
    )
  })
}

/** Test-only: the throttle map is a memory bound, which is not observable from behaviour. */
export function sshProviderMissRecoveryThrottleEntryCount(): number {
  return backgroundRecoveryStartedAt.size
}
