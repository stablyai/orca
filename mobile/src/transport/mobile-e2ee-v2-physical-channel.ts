import {
  createWsOutboundBackpressureQueue,
  type WsOutboundBackpressureQueue
} from '../../../src/shared/ws-outbound-backpressure-queue'
import { getUtf8ByteLength } from '../../../src/shared/utf8-byte-limits'
import type { MobileE2EEV2ClientSession } from './mobile-e2ee-v2-client-session'
import {
  createMobileInboundFrameQueue,
  MOBILE_INBOUND_MAX_FRAME_BYTES,
  type MobileInboundFrameQueue
} from './mobile-inbound-frame-queue'
import {
  processMobileOutboundMemoryBudget,
  MOBILE_OUTBOUND_MAX_FRAME_BYTES,
  type MobileOutboundMemoryBudget
} from './mobile-outbound-memory-budget'
import { stringifyMobileOutboundJson } from './mobile-outbound-json'
import { createMobileOutboundSocketLedger } from './mobile-outbound-socket-ledger'
import { parseMobileJsonTextWithinLimits } from './mobile-json-text-admission'

type ChannelState = 'awaiting-ready' | 'awaiting-authenticated' | 'ready'
type OutboundItem =
  | { kind: 'text'; plaintext: string; acknowledgementKey?: string }
  | { kind: 'binary'; plaintext: Uint8Array }
const E2EE_V2_FRAME_OVERHEAD_BYTES = 82
const AUTHENTICATION_ACKNOWLEDGEMENT_KEY = 'mobile-e2ee-v2-authentication'

export class MobileE2EEAuthenticationError extends Error {
  constructor() {
    super('E2EE device authentication rejected')
  }
}

export type MobileE2EEV2Socket = {
  readonly OPEN: number
  readonly readyState: number
  readonly bufferedAmount: number
  send: (frame: string | Uint8Array) => void
}

export class MobileE2EEV2PhysicalChannel {
  private state: ChannelState = 'awaiting-ready'
  private generation = 0
  private readonly inboundQueue: MobileInboundFrameQueue
  private readonly outboundQueue: WsOutboundBackpressureQueue<OutboundItem>
  private readonly outboundSocketLedger
  private outboundOverflowed = false

  constructor(
    private readonly args: {
      session: MobileE2EEV2ClientSession
      socket: MobileE2EEV2Socket
      deviceToken: string
      decodeBinary: (raw: unknown) => Promise<Uint8Array | null>
      onAuthenticated: () => void
      onText: (plaintext: string) => void
      onBinary: (plaintext: Uint8Array) => void
      onError: (error: Error) => void
      outboundMemoryBudget?: MobileOutboundMemoryBudget
    }
  ) {
    this.inboundQueue = createMobileInboundFrameQueue({
      process: (raw) => this.processMessage(raw, this.generation),
      onError: args.onError,
      overflowMessage: 'E2EE v2 inbound buffer overflow',
      frameTooLargeMessage: 'E2EE v2 inbound frame too large'
    })
    const outboundMemoryBudget = args.outboundMemoryBudget ?? processMobileOutboundMemoryBudget
    this.outboundSocketLedger = createMobileOutboundSocketLedger({
      memoryBudget: outboundMemoryBudget,
      readBufferedAmount: () => args.socket.bufferedAmount
    })
    this.outboundQueue = createWsOutboundBackpressureQueue<OutboundItem>({
      // Why: encryption happens only when an admitted item reaches the wire,
      // so a bounded-queue rejection cannot burn an ordered v2 counter.
      send: (item) => {
        const cancelClaim = this.outboundSocketLedger.claimSentBytes(
          outboundItemRetainedBytes(item),
          item.kind === 'text' ? item.acknowledgementKey : undefined
        )
        if (!cancelClaim) {
          this.failOutboundOverflow()
          return
        }
        try {
          args.socket.send(
            item.kind === 'text'
              ? args.session.sealText(item.plaintext)
              : args.session.sealBinary(item.plaintext)
          )
        } catch {
          cancelClaim()
          this.failOutboundOverflow()
        }
      },
      byteLengthOf: outboundItemRetainedBytes,
      getBufferedAmount: () => args.socket.bufferedAmount,
      isWritable: () => args.socket.readyState === args.socket.OPEN,
      canSend: (bytes) => this.outboundSocketLedger.canSend(bytes),
      claimQueuedBytes: (bytes) => outboundMemoryBudget.claimQueuedBytes(bytes),
      maxFrameBytes: MOBILE_OUTBOUND_MAX_FRAME_BYTES,
      onOverflow: () => this.failOutboundOverflow()
    })
  }

  start(): void {
    this.args.socket.send(JSON.stringify(this.args.session.hello))
  }

  handleMessage(raw: unknown): Promise<void> {
    return this.inboundQueue.enqueue(raw)
  }

  sendText(plaintext: string): boolean {
    return this.enqueueReady({
      kind: 'text',
      plaintext,
      acknowledgementKey: outboundTextAcknowledgementKey(plaintext)
    })
  }

  sendBinary(plaintext: Uint8Array): boolean {
    return this.enqueueReady({ kind: 'binary', plaintext })
  }

  dispose(): void {
    this.generation++
    this.inboundQueue.dispose()
    this.outboundQueue.dispose()
    this.outboundSocketLedger.retire()
  }

  socketClosed(): void {
    this.dispose()
    this.outboundSocketLedger.socketClosed()
  }

  private async processMessage(raw: unknown, generation: number): Promise<void> {
    if (generation !== this.generation) {
      return
    }
    if (this.state === 'awaiting-ready') {
      this.acceptReady(raw)
      return
    }

    const plaintext =
      typeof raw === 'string'
        ? this.args.session.openText(raw)
        : await this.openBinary(raw, generation)
    if (generation !== this.generation || plaintext === null) {
      return
    }
    if (this.state === 'awaiting-authenticated') {
      this.outboundSocketLedger.acknowledge(AUTHENTICATION_ACKNOWLEDGEMENT_KEY)
      if (typeof plaintext === 'string' && isAuthenticationRejection(plaintext)) {
        throw new MobileE2EEAuthenticationError()
      }
      if (typeof plaintext !== 'string' || !this.isAuthenticated(plaintext)) {
        throw new Error('Invalid E2EE v2 authenticated response')
      }
      this.state = 'ready'
      this.args.onAuthenticated()
    } else if (typeof plaintext === 'string') {
      const acknowledgementKey = outboundTextAcknowledgementKey(plaintext)
      if (acknowledgementKey) {
        this.outboundSocketLedger.acknowledge(acknowledgementKey)
      }
      this.args.onText(plaintext)
    } else {
      this.args.onBinary(plaintext)
    }
  }

  private acceptReady(raw: unknown): void {
    if (typeof raw !== 'string') {
      throw new Error('Expected plaintext E2EE v2 ready')
    }
    let ready: unknown
    try {
      ready = parseMobileJsonTextWithinLimits(raw)
    } catch {
      throw new Error('Invalid E2EE v2 ready JSON')
    }
    if (!this.args.session.acceptReady(ready)) {
      throw new Error('Invalid E2EE v2 ready')
    }
    this.state = 'awaiting-authenticated'
    this.outboundQueue.enqueue({
      kind: 'text',
      acknowledgementKey: AUTHENTICATION_ACKNOWLEDGEMENT_KEY,
      plaintext: stringifyMobileOutboundJson({
        type: 'e2ee_auth',
        v: 2,
        transcriptHashB64: this.args.session.transcriptHashB64,
        deviceToken: this.args.deviceToken
      })
    })
  }

  private async openBinary(raw: unknown, generation: number): Promise<Uint8Array | null> {
    const bytes = await this.args.decodeBinary(raw)
    if (!bytes || generation !== this.generation) {
      return null
    }
    if (bytes.byteLength > MOBILE_INBOUND_MAX_FRAME_BYTES) {
      throw new Error('E2EE v2 inbound frame too large')
    }
    return this.args.session.openBinary(bytes)
  }

  private isAuthenticated(plaintext: string): boolean {
    try {
      const message = parseMobileJsonTextWithinLimits<Record<string, unknown>>(plaintext)
      return (
        Object.keys(message).sort().join(',') === 'transcriptHashB64,type,v' &&
        message.type === 'e2ee_authenticated' &&
        message.v === 2 &&
        message.transcriptHashB64 === this.args.session.transcriptHashB64
      )
    } catch {
      return false
    }
  }

  private enqueueReady(item: OutboundItem): boolean {
    if (this.state !== 'ready') {
      return false
    }
    return this.outboundQueue.enqueue(item) && !this.outboundOverflowed
  }

  private failOutboundOverflow(): void {
    if (this.outboundOverflowed) {
      return
    }
    this.outboundOverflowed = true
    this.args.onError(new Error('E2EE v2 outbound buffer overflow'))
  }
}

function isAuthenticationRejection(plaintext: string): boolean {
  try {
    const message = parseMobileJsonTextWithinLimits<Record<string, unknown>>(plaintext)
    return message.type === 'e2ee_error'
  } catch {
    return false
  }
}

function outboundItemRetainedBytes(item: OutboundItem): number {
  if (item.kind === 'binary') {
    return item.plaintext.byteLength + E2EE_V2_FRAME_OVERHEAD_BYTES
  }
  const encryptedBytes = getUtf8ByteLength(item.plaintext) + E2EE_V2_FRAME_OVERHEAD_BYTES
  const wireBytes = Math.ceil(encryptedBytes / 3) * 4
  return Math.max(wireBytes, item.plaintext.length * 2)
}

function outboundTextAcknowledgementKey(plaintext: string): string | undefined {
  try {
    const value = parseMobileJsonTextWithinLimits<{ id?: unknown }>(plaintext)
    return typeof value.id === 'string' ? value.id : undefined
  } catch {
    return undefined
  }
}
