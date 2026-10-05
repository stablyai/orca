import type { SshRelaySession } from '../ssh/ssh-relay-session'
import { setSshActiveMultiplexerResolver } from '../ssh/ssh-target-registry'
import { setWorktreeRemovalSshHostHomeResolver } from '../worktree-removal-execution-host-route'

// One session per SSH target owns the whole relay lifecycle (mux, providers, abort controller, state machine).
export const activeSessions = new Map<string, SshRelaySession>()

// Why at module scope: this resolver is pure state lookup with no handler lifecycle, so
// installing it on import keeps it correct even before registerSshHandlers runs.
setSshActiveMultiplexerResolver(
  (connectionId) => activeSessions.get(connectionId)?.getMux() ?? undefined
)

/**
 * The `$HOME` the SSH host reported, or `null` while no session has resolved it.
 *
 * `null` means unknown, never "same as this client's home" — callers must keep
 * their path-shape guards rather than fall back to `os.homedir()`.
 */
export function getActiveSshHostHomeDirectory(targetId: string): string | null {
  return activeSessions.get(targetId)?.getRemoteHomeDirectory() ?? null
}

setWorktreeRemovalSshHostHomeResolver(getActiveSshHostHomeDirectory)
