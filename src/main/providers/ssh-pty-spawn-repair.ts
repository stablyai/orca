/**
 * The client seam for #17830: a spawn the relay refused because it cannot load node-pty.
 *
 * Split out of ssh-pty-provider.ts so the provider keeps only the wiring. The repair itself is
 * driven by SshRelaySession, which owns the connection, the repair lock and the reconnect.
 */
import {
  mayRepairFromCause,
  terminalUnavailableCauseFromError,
  type TerminalUnavailableCause
} from '../../shared/terminal-unavailable-cause'

/** Resolves to the provider registered after a successful repair, or null to keep the rejection. */
export type TerminalRepairHook<TProvider> = (
  cause: TerminalUnavailableCause
) => Promise<TProvider | null>

/**
 * Run a spawn, and on a proved-repairable terminal-unavailable rejection repair the host and
 * retry exactly once on the provider the repair produced.
 *
 * Re-issuing is safe because a validated cause is the host's own statement that admission was
 * refused before any PTY existed, so there is nothing to duplicate. The retry deliberately goes
 * through a caller-supplied thunk that does not re-enter this wrapper, so it cannot recurse.
 * Gated on `mayRepairFromCause`, never on the peer's `repairable` flag alone.
 */
export async function spawnWithTerminalRuntimeRepair<TProvider, TResult>(args: {
  attempt: () => Promise<TResult>
  recover: TerminalRepairHook<TProvider> | null
  retry: (provider: TProvider) => Promise<TResult>
}): Promise<TResult> {
  try {
    return await args.attempt()
  } catch (error) {
    const cause = terminalUnavailableCauseFromError(error)
    if (!cause || !mayRepairFromCause(cause) || !args.recover) {
      throw error
    }
    const repaired = await args.recover(cause)
    if (!repaired) {
      throw error
    }
    return await args.retry(repaired)
  }
}
