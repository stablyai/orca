import { BRIDGE_PROTOCOL_VERSION, type BridgeHostMessage } from './bridge/bridge-envelope'
import { BRIDGE_BACK_FRAME } from './bridge/bridge-page-back'

/**
 * What one session has established about the device Back key: what its page declared it takes, and
 * whether it is holding the key right now.
 *
 * Carried across a host rebuild rather than relearned, the way `sessionEstablished` already is. A
 * client swapped under a live page is not a new document — the WebView stays mounted and the page
 * is never told — so a host that started over would refuse every press and pop the screen out from
 * under an open sheet.
 */
export type BridgeSessionBack = {
  /** What the page's last `ready` said it takes. Empty for a page too old to name the frame. */
  readonly accepts: readonly string[]
  readonly claimed: boolean
}

/**
 * One host's end of the device Back key: what the document on the other side claimed, and whether
 * a press can be handed to it.
 *
 * Its own module because the claim is the one page fact with a staleness hazard of its own. A claim
 * that outlived its document would have the shell hand Back to a page with nothing to do with it,
 * which is a key that does nothing at all — so every way a document ends drops it here, and the
 * reader above never has to remember to.
 *
 * A document ending is not a host ending. `drop` is for the first; the second hands `read` to
 * whoever builds the replacement, and reports nothing, because the claim belongs to the session.
 */
export type BridgeHostBack = {
  /** A document has spoken: it takes what it named, and claims nothing until it says otherwise. */
  readonly readReady: (accepts: readonly string[]) => void
  /** The page holding Back, or letting it go. */
  readonly readClaim: (claimed: boolean) => void
  /**
   * Posts one press. False when this page never said it takes one — every page older than the
   * frame — and the caller then leaves Back to the navigator, which is what it did before this.
   */
  readonly send: () => boolean
  /** The document is gone; whatever it claimed goes with it. */
  readonly drop: () => void
  /** What this session has established, for the host that takes over from this one. */
  readonly read: () => BridgeSessionBack
}

export function createBridgeHostBack(args: {
  send: (frame: BridgeHostMessage) => void
  /** Whether a document holds the view and has had its `init`. */
  deliverable: () => boolean
  onClaim: (claimed: boolean) => void
  /** What the session already established, when this host is a rebuild taking one over. Absent for
   *  a host opening a session of its own, which has established nothing yet. */
  established?: BridgeSessionBack
}): BridgeHostBack {
  let accepts: readonly string[] = args.established?.accepts ?? []
  // Seeded without a report: the screen never heard this claim go, because it did not.
  let claimed = args.established?.claimed ?? false

  function drop(): void {
    if (!claimed) {
      return
    }
    claimed = false
    args.onClaim(false)
  }

  return {
    readReady: (next) => {
      accepts = next
      drop()
    },
    readClaim: (next) => {
      if (next === claimed) {
        return
      }
      claimed = next
      args.onClaim(next)
    },
    send: () => {
      if (!accepts.includes(BRIDGE_BACK_FRAME) || !args.deliverable()) {
        return false
      }
      args.send({ v: BRIDGE_PROTOCOL_VERSION, type: BRIDGE_BACK_FRAME })
      return true
    },
    drop,
    read: () => ({ accepts, claimed })
  }
}
