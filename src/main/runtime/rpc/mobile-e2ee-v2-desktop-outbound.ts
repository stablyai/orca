import type { WebSocket } from 'ws'
import {
  createWsOutboundBackpressureQueue,
  type WsOutboundBackpressureQueue
} from '../../../shared/ws-outbound-backpressure-queue'
import type { DesktopMobileE2EEV2Session } from './mobile-e2ee-v2-desktop-session'

export type DesktopMobileE2EEV2OutboundItem =
  | { kind: 'text'; plaintext: string }
  | { kind: 'binary'; plaintext: Uint8Array<ArrayBufferLike> }

export function createDesktopMobileE2EEV2OutboundQueue(args: {
  ws: WebSocket
  session: DesktopMobileE2EEV2Session
  onOverflow: () => void
}): WsOutboundBackpressureQueue<DesktopMobileE2EEV2OutboundItem> {
  return createWsOutboundBackpressureQueue<DesktopMobileE2EEV2OutboundItem>({
    // Why: sealing happens only after queue admission, so counters cannot be
    // consumed by an item rejected at the bounded queue boundary.
    send: (item) => {
      if (item.kind === 'text') {
        args.ws.send(args.session.sealText(item.plaintext))
      } else {
        args.ws.send(Buffer.from(args.session.sealBinary(item.plaintext)), { binary: true })
      }
    },
    byteLengthOf: (item) =>
      (item.kind === 'text'
        ? new TextEncoder().encode(item.plaintext).length
        : item.plaintext.length) + 82,
    getBufferedAmount: () => args.ws.bufferedAmount,
    isWritable: () => args.ws.readyState === args.ws.OPEN,
    onOverflow: args.onOverflow
  })
}
