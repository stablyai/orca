import type { Store } from '../../../persistence'
import { ptyIncarnationById } from '../provider/ownership-state'
import { getRelayPtyId } from '../provider/registry'

export type UndeliveredSshPtyKill = {
  store: Store | undefined
  ptyId: string
  connectionId: string | null | undefined
  /** Whether this caller may still undo the stop. Every caller states it rather than having it
   *  inferred, because both directions are bugs: `true` on a real close re-opens the leak, and
   *  `false` on a reversible one lets a later handshake kill a pane the user went back to using.
   *  Worktree sleep is the reversible case, on both the runtime and the renderer route. */
  reversible: boolean
  /** Pass what `finishPtyShutdown` returned: it clears the live map, so a caller that already ran
   *  it can no longer look the incarnation up. */
  incarnationId?: string
  now?: number
}

/** Durably records a stop this client asked for on an SSH host and could not confirm, so the next
 *  handshake to that host can replay it. Without this the remote PTY — a child of the detached
 *  relay daemon, not of the ssh channel — outlives the failed RPC forever.
 *
 *  The silent no-ops are the safety rules, not defensive padding:
 *  - **reversible**: see above.
 *  - **no `connectionId`**: a local PTY's owner is this process, so a failed kill has no later host
 *    to ask; there is nothing to replay against.
 *  - **no incarnation**: the replay fence is the host-minted PTY incarnation, and a relay renumbers
 *    from `pty-1` on every start. An order we could never safely aim can only be discarded later,
 *    or worse, guessed at.
 *  - **an id naming another connection**: `getRelayPtyId` throws on those, and this runs inside
 *    promise `.catch` handlers where that would surface as an unhandled rejection. */
export function recordUndeliveredSshPtyKill(args: UndeliveredSshPtyKill): void {
  const { store, ptyId, connectionId } = args
  if (!store || !connectionId || args.reversible) {
    return
  }
  const incarnationId = args.incarnationId ?? ptyIncarnationById.get(ptyId)
  if (!incarnationId) {
    return
  }
  let relayPtyId: string
  try {
    relayPtyId = getRelayPtyId(connectionId, ptyId)
  } catch {
    return
  }
  store.recordSshRemotePtyKillIntent(connectionId, relayPtyId, {
    requestedAt: args.now ?? Date.now(),
    incarnationId,
    attempts: 0
  })
}
