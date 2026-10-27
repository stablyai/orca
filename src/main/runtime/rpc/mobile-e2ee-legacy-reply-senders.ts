import type { WebSocket } from 'ws'
import { encrypt } from '../../../shared/e2ee-crypto'
import type { MobileE2EEDesktopOutboundOwner } from './mobile-e2ee-desktop-outbound-owner'
import {
  isMobileE2EEBinaryPayloadWithinLimit,
  isMobileE2EETextPayloadWithinLimit
} from './mobile-e2ee-outbound-admission'
import type { RpcBinarySender } from './rpc-binary-sender'

/** Reply senders for one legacy-framed request. */
export function createLegacyReplySenders(args: {
  ws: WebSocket
  outbound: MobileE2EEDesktopOutboundOwner
  getSharedKey: () => Uint8Array | null
  onOversize: () => void
}): { text: (response: string) => void; binary: RpcBinarySender } {
  return {
    // Why: streaming emits can outlive destroy(), so late replies must not encrypt with a cleared key.
    text: (response) => {
      const sharedKey = args.getSharedKey()
      if (!sharedKey || args.ws.readyState !== args.ws.OPEN) {
        return
      }
      if (!isMobileE2EETextPayloadWithinLimit(response)) {
        args.onOversize()
        return
      }
      args.outbound.enqueueLegacyText(encrypt(response, sharedKey))
    },
    binary: (response, options) => {
      const sharedKey = args.getSharedKey()
      if (!sharedKey || args.ws.readyState !== args.ws.OPEN) {
        return false
      }
      if (!isMobileE2EEBinaryPayloadWithinLimit(response)) {
        args.onOversize()
        return false
      }
      return args.outbound.enqueueLegacyBinary(response, sharedKey, options)
    }
  }
}
