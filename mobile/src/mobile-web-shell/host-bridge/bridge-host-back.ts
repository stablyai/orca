import { BRIDGE_PROTOCOL_VERSION } from '../bridge/protocol/bridge-frame-fields'
import type { BridgeHostMessage } from '../bridge/protocol/bridge-envelope'
import {
  BRIDGE_BACK_FRAME,
  type BridgeBackEdgeGuard
} from '../bridge/page-lifecycle/bridge-page-back'

// Carry Back state across client-driven host rebuilds: the page remains mounted and is never told to claim again.
export type BridgeSessionBack = {
  readonly claimed: boolean
  /** The negotiated storage keys the page's `ready` named; absent for a page that named none. */
  readonly storageKeys?: readonly string[]
  /** The page's `ready` said it reads `connectionPath` frames. */
  readonly connectionPathFrames?: true
  /** The page's `ready` said it reads `appInactive` frames. */
  readonly appInactiveFrames?: true
  /** The page's `ready` said it answers `appResumed` frames. */
  readonly appResumedFrames?: true
  readonly botItemLinks?: true
  readonly terminalKeyRailClaim?: { readonly inputOwner?: string }
}

// Drop claims when their document ends to avoid swallowing Back on an unrelated page. Host disposal alone transfers the session’s read state without reporting a dropped claim.
export type BridgeHostBack = {
  readonly readReady: () => void
  readonly readClaim: (claimed: boolean, edgeGuards?: readonly BridgeBackEdgeGuard[]) => void
  // False leaves the press to native navigation.
  readonly send: () => boolean
  readonly drop: () => void
  readonly read: () => BridgeSessionBack
}

const NO_EDGE_GUARDS: readonly BridgeBackEdgeGuard[] = []

export function createBridgeHostBack(args: {
  send: (frame: BridgeHostMessage) => void
  deliverable: () => boolean
  onClaim: (claimed: boolean) => void
  /** Where an edge swipe stays with the page; empty when its document ends. */
  onEdgeGuards?: (edgeGuards: readonly BridgeBackEdgeGuard[]) => void
  // Seed only when rebuilding an established session; a newly opened session has no prior claim.
  established?: BridgeSessionBack
}): BridgeHostBack {
  // Seed silently because the screen never saw the live claim end.
  let claimed = args.established?.claimed ?? false
  // What the screen was last told, so a page re-sending the same bands on each init costs no render.
  let lastGuards = ''

  function readGuards(edgeGuards: readonly BridgeBackEdgeGuard[]): void {
    const key = JSON.stringify(edgeGuards)
    if (key !== lastGuards) {
      lastGuards = key
      args.onEdgeGuards?.(edgeGuards)
    }
  }

  function drop(): void {
    // Always, even with nothing sent here: a rebuilt host doesn't know what the screen still holds.
    lastGuards = ''
    args.onEdgeGuards?.(NO_EDGE_GUARDS)
    if (!claimed) {
      return
    }
    claimed = false
    args.onClaim(false)
  }

  return {
    readReady: drop,
    readClaim: (next, edgeGuards) => {
      // Pages from before the field send none, and keep their guards as they were (none).
      if (edgeGuards !== undefined) {
        readGuards(edgeGuards)
      }
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
