import type { WebSocket } from 'ws'
import {
  createWsOutboundBackpressureQueue,
  type WsOutboundBackpressureQueue
} from '../../../shared/ws-outbound-backpressure-queue'
import {
  REMOTE_RUNTIME_MAX_OUTBOUND_BINARY_FRAME_BYTES,
  REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES
} from '../../../shared/remote-runtime-memory-limits'
import type {
  MobileE2EEOutboundMemoryBudget,
  MobileE2EEOutboundSocketMemory
} from './mobile-e2ee-outbound-memory-budget'

export function mobileE2EETextPayloadAdmissionBytes(value: string): number {
  const bytes = Buffer.byteLength(value, 'utf8')
  return bytes <= REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES ? bytes : Number.POSITIVE_INFINITY
}

export function isMobileE2EETextPayloadWithinLimit(value: string): boolean {
  return Number.isFinite(mobileE2EETextPayloadAdmissionBytes(value))
}

export function mobileE2EEBinaryPayloadAdmissionBytes(value: Uint8Array<ArrayBufferLike>): number {
  return value.byteLength <= REMOTE_RUNTIME_MAX_OUTBOUND_BINARY_FRAME_BYTES
    ? value.byteLength
    : Number.POSITIVE_INFINITY
}

export function isMobileE2EEBinaryPayloadWithinLimit(value: Uint8Array<ArrayBufferLike>): boolean {
  return Number.isFinite(mobileE2EEBinaryPayloadAdmissionBytes(value))
}

export function isMobileE2EEOutboundItemWithinLimit(
  item:
    | { kind: 'text'; plaintext: string }
    | { kind: 'binary'; plaintext: Uint8Array<ArrayBufferLike> }
): boolean {
  return item.kind === 'text'
    ? isMobileE2EETextPayloadWithinLimit(item.plaintext)
    : isMobileE2EEBinaryPayloadWithinLimit(item.plaintext)
}

export function createLegacyMobileE2EETextReplyQueue(args: {
  ws: WebSocket
  isKeyed: () => boolean
  onOverflow: () => void
  memoryBudget: MobileE2EEOutboundMemoryBudget
  socketMemory: MobileE2EEOutboundSocketMemory
}): WsOutboundBackpressureQueue<string> {
  return createWsOutboundBackpressureQueue<string>({
    send: (frame) => args.ws.send(frame),
    // Encrypted replies are base64 ASCII strings, so length === byte count.
    byteLengthOf: (frame) => frame.length,
    getBufferedAmount: () => args.ws.bufferedAmount,
    isWritable: () => args.isKeyed() && args.ws.readyState === args.ws.OPEN,
    canSend: (bytes) => args.socketMemory.canSend(bytes),
    claimQueuedBytes: (bytes) => args.memoryBudget.claimQueuedBytes(bytes),
    onOverflow: args.onOverflow
  })
}
