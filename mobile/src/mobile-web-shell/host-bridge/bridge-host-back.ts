import { BRIDGE_PROTOCOL_VERSION } from '../bridge/protocol/bridge-frame-fields'
import type { BridgeHostMessage } from '../bridge/protocol/bridge-envelope'
import { BRIDGE_BACK_FRAME } from '../bridge/page-lifecycle/bridge-page-back'
import type { BridgeHostOptions } from './bridge-host-contract'
import {
  BRIDGE_PAGE_HEADER_ACTION_FRAME,
  type BridgePageHeader
} from '../bridge/native-capabilities/bridge-page-header'

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
  /** The page holds the shell-drawn header, so its presses may be forwarded. */
  readonly pageHeaderClaimed?: true
}

// Drop claims when their document ends to avoid swallowing Back on an unrelated page. Host disposal alone transfers the session’s read state without reporting a dropped claim.
export type BridgeHostBack = {
  readonly readReady: () => void
  readonly readClaim: (claimed: boolean) => void
  // False leaves the press to native navigation.
  readonly send: () => boolean
  readonly drop: () => void
  readonly read: () => BridgeSessionBack
  // The shell-drawn header is the page's other way back, so it starts and ends with the document too.
  readonly readHeader: (header: BridgePageHeader | null) => void
  // False while no document holds a header claim.
  readonly sendHeaderAction: (actionId: string) => boolean
}

export function createBridgeHostBack(args: {
  send: (frame: BridgeHostMessage) => void
  deliverable: () => boolean
  report: Pick<BridgeHostOptions, 'onPageBackClaim' | 'onPageHeader'>
  // Seed only when rebuilding an established session; a newly opened session has no prior claim.
  established?: BridgeSessionBack
}): BridgeHostBack {
  // Seed silently because the screen never saw the live claim end.
  let claimed = args.established?.claimed ?? false
  let headerClaimed = args.established?.pageHeaderClaimed === true

  function readHeader(header: BridgePageHeader | null): void {
    headerClaimed = header !== null
    args.report.onPageHeader?.(header)
  }

  function drop(): void {
    readHeader(null)
    if (!claimed) {
      return
    }
    claimed = false
    args.report.onPageBackClaim(false)
  }

  return {
    readReady: drop,
    readClaim: (next) => {
      if (next === claimed) {
        return
      }
      claimed = next
      args.report.onPageBackClaim(next)
    },
    send: () => {
      if (!args.deliverable()) {
        return false
      }
      args.send({ v: BRIDGE_PROTOCOL_VERSION, type: BRIDGE_BACK_FRAME })
      return true
    },
    drop,
    read: () => ({ claimed, ...(headerClaimed ? { pageHeaderClaimed: true as const } : {}) }),
    readHeader,
    sendHeaderAction: (actionId) => {
      if (!headerClaimed || !args.deliverable()) {
        return false
      }
      args.send({ v: BRIDGE_PROTOCOL_VERSION, type: BRIDGE_PAGE_HEADER_ACTION_FRAME, actionId })
      return true
    }
  }
}
