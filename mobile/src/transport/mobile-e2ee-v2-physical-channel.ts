import {
  createWsOutboundBackpressureQueue,
  type WsOutboundBackpressureQueue
} from '../../../src/shared/ws-outbound-backpressure-queue'
import type { MobileE2EEV2ClientSession } from './mobile-e2ee-v2-client-session'

type ChannelState = 'awaiting-ready' | 'awaiting-authenticated' | 'ready'
type OutboundItem = { kind: 'text'; plaintext: string } | { kind: 'binary'; plaintext: Uint8Array }

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
  private inboundChain: Promise<void> = Promise.resolve()
  private readonly outboundQueue: WsOutboundBackpressureQueue<OutboundItem>

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
    }
  ) {
    this.outboundQueue = createWsOutboundBackpressureQueue<OutboundItem>({
      // Why: encryption happens only when an admitted item reaches the wire,
      // so a bounded-queue rejection cannot burn an ordered v2 counter.
      send: (item) => {
        args.socket.send(
          item.kind === 'text'
            ? args.session.sealText(item.plaintext)
            : args.session.sealBinary(item.plaintext)
        )
      },
      byteLengthOf: (item) =>
        (item.kind === 'text'
          ? new TextEncoder().encode(item.plaintext).length
          : item.plaintext.length) + 82,
      getBufferedAmount: () => args.socket.bufferedAmount,
      isWritable: () => args.socket.readyState === args.socket.OPEN,
      onOverflow: () => args.onError(new Error('E2EE v2 outbound buffer overflow'))
    })
  }

  start(): void {
    this.args.socket.send(JSON.stringify(this.args.session.hello))
  }

  handleMessage(raw: unknown): Promise<void> {
    const generation = this.generation
    this.inboundChain = this.inboundChain
      .then(() => this.processMessage(raw, generation))
      .catch((error: unknown) => {
        if (generation === this.generation) {
          this.args.onError(error instanceof Error ? error : new Error(String(error)))
        }
      })
    return this.inboundChain
  }

  sendText(plaintext: string): boolean {
    return this.enqueueReady({ kind: 'text', plaintext })
  }

  sendBinary(plaintext: Uint8Array): boolean {
    return this.enqueueReady({ kind: 'binary', plaintext })
  }

  dispose(): void {
    this.generation++
    this.outboundQueue.dispose()
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
      if (typeof plaintext === 'string' && isAuthenticationRejection(plaintext)) {
        throw new MobileE2EEAuthenticationError()
      }
      if (typeof plaintext !== 'string' || !this.isAuthenticated(plaintext)) {
        throw new Error('Invalid E2EE v2 authenticated response')
      }
      this.state = 'ready'
      this.args.onAuthenticated()
    } else if (typeof plaintext === 'string') {
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
      ready = JSON.parse(raw)
    } catch {
      throw new Error('Invalid E2EE v2 ready JSON')
    }
    if (!this.args.session.acceptReady(ready)) {
      throw new Error('Invalid E2EE v2 ready')
    }
    this.state = 'awaiting-authenticated'
    this.outboundQueue.enqueue({
      kind: 'text',
      plaintext: JSON.stringify({
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
    return this.args.session.openBinary(bytes)
  }

  private isAuthenticated(plaintext: string): boolean {
    try {
      const message = JSON.parse(plaintext) as Record<string, unknown>
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
    this.outboundQueue.enqueue(item)
    return true
  }
}

function isAuthenticationRejection(plaintext: string): boolean {
  try {
    const message = JSON.parse(plaintext) as Record<string, unknown>
    return message.type === 'e2ee_error'
  } catch {
    return false
  }
}
