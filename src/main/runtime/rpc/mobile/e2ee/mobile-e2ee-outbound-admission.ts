import type { WebSocket } from 'ws'
import {
  createWsOutboundBackpressureQueue,
  type WsOutboundBackpressureQueue,
  type WsOutboundOverflowEvidence
} from '../../../../../shared/network/websocket/ws-outbound-backpressure-queue'
import {
  REMOTE_RUNTIME_MAX_OUTBOUND_BINARY_FRAME_BYTES,
  REMOTE_RUNTIME_MAX_OUTBOUND_JSON_BYTES
} from '../../../../../shared/remote-runtime/remote-runtime-memory-limits'
import type {
  MobileE2EEOutboundMemoryBudget,
  MobileE2EEOutboundSocketMemory
} from './mobile-e2ee-outbound-memory-budget'
import type { EventProps } from '../../../../../shared/telemetry/telemetry-event-classification'
import { track } from '../../../../telemetry/client'
import { MOBILE_RPC_METHOD_ALLOWLIST } from '../../server/runtime-rpc-mobile-method-allowlist'
import { classifyJsonRpcPrefix } from '../../../../../shared/json-stream/json-rpc-record-prefix'

export type MobileE2EEOutboundBudgetClose = EventProps<'remote_outbound_budget_close'>
export type MobileE2EEOutboundBudgetEmitter = MobileE2EEOutboundBudgetClose['emitter']
export type MobileE2EEOutboundCap = NonNullable<MobileE2EEOutboundBudgetClose['cap']>

/** The phone request a reply answers, as a known method name so telemetry stays bounded. */
export function mobileE2EEReplyMethod(request: string): string {
  // Top-level keys only, so a nested params.method can't stand in for the request's.
  const envelope = classifyJsonRpcPrefix(request.slice(0, 512))
  const method = 'method' in envelope ? envelope.method : undefined
  return method && MOBILE_RPC_METHOD_ALLOWLIST.has(method) ? method : 'other'
}

export function trackMobileE2EEOutboundBudgetClose(close: MobileE2EEOutboundBudgetClose): void {
  try {
    track('remote_outbound_budget_close', close)
  } catch {
    // Telemetry is best-effort; closing the unsafe socket remains authoritative.
  }
}

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

export function createLegacyMobileE2EEReplyQueue(args: {
  ws: WebSocket
  isKeyed: () => boolean
  onOverflow: (evidence: WsOutboundOverflowEvidence) => void
  memoryBudget: MobileE2EEOutboundMemoryBudget
  socketMemory: MobileE2EEOutboundSocketMemory
}): WsOutboundBackpressureQueue<string | Buffer> {
  return createWsOutboundBackpressureQueue<string | Buffer>({
    send: (frame) =>
      typeof frame === 'string' ? args.ws.send(frame) : args.ws.send(frame, { binary: true }),
    // Encrypted text replies are base64 ASCII strings, so length === byte count.
    byteLengthOf: (frame) => (typeof frame === 'string' ? frame.length : frame.byteLength),
    getBufferedAmount: () => args.ws.bufferedAmount,
    isWritable: () => args.isKeyed() && args.ws.readyState === args.ws.OPEN,
    canSend: (bytes) => args.socketMemory.canSend(bytes),
    claimQueuedBytes: (bytes) => args.memoryBudget.claimQueuedBytes(bytes),
    onOverflow: args.onOverflow
  })
}
