import { BRIDGE_PROTOCOL_VERSION, type BridgeHostMessage } from './bridge/bridge-envelope'
import { BRIDGE_BACK_FRAME } from './bridge/bridge-page-back'

// Carry Back state across client-driven host rebuilds: the page remains mounted and is never told to claim again.
export type BridgeSessionBack = {
  readonly claimed: boolean
}

// Drop claims when their document ends to avoid swallowing Back on an unrelated page. Host disposal alone transfers the session’s read state without reporting a dropped claim.
export type BridgeHostBack = {
  readonly readReady: () => void
  readonly readClaim: (claimed: boolean) => void
  // False leaves the press to native navigation.
  readonly send: () => boolean
  readonly drop: () => void
  readonly read: () => BridgeSessionBack
}

export function createBridgeHostBack(args: {
  send: (frame: BridgeHostMessage) => void
  deliverable: () => boolean
  onClaim: (claimed: boolean) => void
  // Seed only when rebuilding an established session; a newly opened session has no prior claim.
  established?: BridgeSessionBack
}): BridgeHostBack {
  // Seed silently because the screen never saw the live claim end.
  let claimed = args.established?.claimed ?? false

  function drop(): void {
    if (!claimed) {
      return
    }
    claimed = false
    args.onClaim(false)
  }

  return {
    readReady: drop,
    readClaim: (next) => {
      if (next === claimed) {
        return
      }
      claimed = next
      args.onClaim(next)
    },
    send: () => {
      if (!args.deliverable()) {
        return false
      }
      args.send({ v: BRIDGE_PROTOCOL_VERSION, type: BRIDGE_BACK_FRAME })
      return true
    },
    drop,
    read: () => ({ claimed })
  }
}
