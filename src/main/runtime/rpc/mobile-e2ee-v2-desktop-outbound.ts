import type { WebSocket } from 'ws'
import {
  createWsOutboundBackpressureQueue,
  type WsOutboundBackpressureQueue
} from '../../../shared/ws-outbound-backpressure-queue'
import type { DesktopMobileE2EEV2Session } from './mobile-e2ee-v2-desktop-session'
import {
  mobileE2EEBinaryPayloadAdmissionBytes,
  mobileE2EETextPayloadAdmissionBytes
} from './mobile-e2ee-outbound-admission'
import type {
  MobileE2EEOutboundMemoryBudget,
  MobileE2EEOutboundSocketMemory
} from './mobile-e2ee-outbound-memory-budget'

export type DesktopMobileE2EEV2OutboundItem =
  | { kind: 'text'; plaintext: string }
  | { kind: 'binary'; plaintext: Uint8Array<ArrayBufferLike> }

export function createDesktopMobileE2EEV2OutboundQueue(args: {
  ws: WebSocket
  session: DesktopMobileE2EEV2Session
  onOverflow: () => void
  memoryBudget: MobileE2EEOutboundMemoryBudget
  socketMemory: MobileE2EEOutboundSocketMemory
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
    byteLengthOf: (item) => {
      const bytes =
        item.kind === 'text'
          ? mobileE2EETextPayloadAdmissionBytes(item.plaintext)
          : mobileE2EEBinaryPayloadAdmissionBytes(item.plaintext)
      return Number.isFinite(bytes) ? bytes + 82 : bytes
    },
    getBufferedAmount: () => args.ws.bufferedAmount,
    isWritable: () => args.ws.readyState === args.ws.OPEN,
    canSend: (bytes) => args.socketMemory.canSend(bytes),
    claimQueuedBytes: (bytes) => args.memoryBudget.claimQueuedBytes(bytes),
    onOverflow: args.onOverflow
  })
}
