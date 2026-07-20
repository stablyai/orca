import {
  RelayPhoneHelloSchema,
  type RelayPhoneHello
} from '../../../src/shared/mobile-relay-phone-protocol'
import { MobileE2EEV2ClientSession } from './mobile-e2ee-v2-client-session'
import { MobileE2EEV2PhysicalChannel } from './mobile-e2ee-v2-physical-channel'
import { websocketPayloadToUint8 } from './websocket-payload-bytes'

export class RelayOuterError extends Error {
  constructor(readonly code: number) {
    super(`relay_outer_${code}`)
  }
}

type MobileRelayE2eeLinkOptions = {
  endpoint: { cellUrl: string; relayHostId: string }
  credential: string
  expectedCredentialKind: 'invite' | 'resume'
  deviceToken: string
  desktopPublicKeyB64: string
  onAuthenticated: () => void
  onText: (plaintext: string) => void
  onBinary: (plaintext: Uint8Array) => void
  onHello?: (hello: Extract<RelayPhoneHello, { ok: true }>) => void
  onError: (error: Error) => void
  createSocket?: (url: string) => WebSocket
}

export class MobileRelayE2eeLink {
  private readonly options: MobileRelayE2eeLinkOptions
  private readonly socket: WebSocket
  private readonly channel: MobileE2EEV2PhysicalChannel
  private outerReady = false
  private closed = false
  private inboundChain: Promise<void> = Promise.resolve()

  constructor(options: MobileRelayE2eeLinkOptions) {
    this.options = options
    this.socket = (options.createSocket ?? ((url) => new WebSocket(url)))(
      relaySocketUrl(options.endpoint)
    )
    const session = MobileE2EEV2ClientSession.create({
      desktopPublicKeyB64: options.desktopPublicKeyB64,
      transport: 'relay',
      relayHostId: options.endpoint.relayHostId
    })
    this.channel = new MobileE2EEV2PhysicalChannel({
      session,
      socket: this.socket,
      deviceToken: options.deviceToken,
      decodeBinary: websocketPayloadToUint8,
      onAuthenticated: options.onAuthenticated,
      onText: options.onText,
      onBinary: options.onBinary,
      onError: (error) => this.fail(error)
    })
    this.bindSocket()
  }

  sendText(plaintext: string): boolean {
    return !this.closed && this.channel.sendText(plaintext)
  }

  sendBinary(plaintext: Uint8Array): boolean {
    return !this.closed && this.channel.sendBinary(plaintext)
  }

  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.channel.dispose()
    this.socket.close()
  }

  private bindSocket(): void {
    this.socket.onopen = () => {
      this.socket.send(
        JSON.stringify({
          type: 'relay-auth',
          v: 1,
          mode: 'connect',
          credential: this.options.credential
        })
      )
    }
    this.socket.onmessage = (event) => {
      this.inboundChain = this.inboundChain
        .then(async () => {
          if (this.closed) {
            return
          }
          if (!this.outerReady) {
            this.acceptHello(event.data)
          } else {
            await this.channel.handleMessage(event.data)
          }
        })
        .catch((error: unknown) => this.fail(asError(error)))
    }
    this.socket.onerror = () => this.fail(new Error('relay transport error'))
    this.socket.onclose = (event) => this.fail(new RelayOuterError(event.code || 1006))
  }

  private acceptHello(raw: unknown): void {
    if (typeof raw !== 'string') {
      throw new Error('expected plaintext relay hello')
    }
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      throw new Error('invalid relay hello JSON')
    }
    const parsed = RelayPhoneHelloSchema.safeParse(value)
    if (!parsed.success) {
      throw new Error('invalid relay hello')
    }
    if (!parsed.data.ok) {
      throw new RelayOuterError(parsed.data.code)
    }
    if (parsed.data.credentialKind !== this.options.expectedCredentialKind) {
      throw new Error('relay credential resolved as an unexpected credential kind')
    }
    this.outerReady = true
    this.options.onHello?.(parsed.data)
    this.channel.start()
  }

  private fail(error: Error): void {
    if (this.closed) {
      return
    }
    this.closed = true
    this.channel.dispose()
    this.options.onError(error)
    this.socket.close()
  }
}

function relaySocketUrl(endpoint: { cellUrl: string; relayHostId: string }): string {
  const url = new URL(endpoint.cellUrl)
  url.protocol = 'wss:'
  url.pathname = `/v1/connect/${encodeURIComponent(endpoint.relayHostId)}`
  return url.toString()
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
