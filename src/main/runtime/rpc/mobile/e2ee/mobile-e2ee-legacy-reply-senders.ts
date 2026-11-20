import type { WebSocket } from 'ws'
import { encrypt } from '../../../../../shared/remote-runtime/e2ee/node/e2ee-crypto'
import type { MobileE2EEDesktopOutboundOwner } from './mobile-e2ee-desktop-outbound-owner'
import {
  isMobileE2EEBinaryPayloadWithinLimit,
  isMobileE2EETextPayloadWithinLimit,
  mobileE2EEReplyMethod,
  type MobileE2EEOutboundBudgetClose
} from './mobile-e2ee-outbound-admission'
import type { RpcBinarySender } from '../../transports/rpc-binary-sender'

/** Reply senders for one legacy-framed request. */
export function createLegacyReplySenders(args: {
  ws: WebSocket
  outbound: MobileE2EEDesktopOutboundOwner
  /** The request these replies answer; its method names an overflow in telemetry. */
  request: string
  getSharedKey: () => Uint8Array | null
  onOversize: (close: MobileE2EEOutboundBudgetClose) => void
}): { text: (response: string) => void; binary: RpcBinarySender } {
  const method = mobileE2EEReplyMethod(args.request)
  return {
    // Why: streaming emits can outlive destroy(), so late replies must not encrypt with a cleared key.
    text: (response) => {
      const sharedKey = args.getSharedKey()
      if (!sharedKey || args.ws.readyState !== args.ws.OPEN) {
        return
      }
      if (!isMobileE2EETextPayloadWithinLimit(response)) {
        args.onOversize({ emitter: 'size', cap: 'maxFrameBytes', top_method: method })
        return
      }
      args.outbound.enqueueLegacyText(encrypt(response, sharedKey), method)
    },
    binary: (response, options) => {
      const sharedKey = args.getSharedKey()
      if (!sharedKey || args.ws.readyState !== args.ws.OPEN) {
        return false
      }
      if (!isMobileE2EEBinaryPayloadWithinLimit(response)) {
        args.onOversize({ emitter: 'size', cap: 'maxFrameBytes', top_method: method })
        return false
      }
      return args.outbound.enqueueLegacyBinary(response, sharedKey, method, options)
    }
  }
}
