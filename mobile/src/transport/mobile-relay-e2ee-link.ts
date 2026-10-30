import {
  RelayPhoneHelloSchema,
  type RelayPhoneHello
} from '../../../src/shared/mobile-relay-phone-protocol'
import {
  relayHostCloseReasonFrom,
  type RelayHostCloseReason
} from '../../../src/shared/relay-host-close-reason'
import { latchHostToE2EEV2 } from './e2ee-v2-host-latch'
import { MobileE2EEV2ClientSession } from './mobile-e2ee-v2-client-session'
import { MobileE2EEV2PhysicalChannel } from './mobile-e2ee-v2-physical-channel'
import { websocketPayloadToUint8 } from './websocket-payload-bytes'
import { relayConnectWebSocketUrl } from './mobile-relay-connect-url'
import { WsInboundMessageQueue } from '../../../src/shared/ws-inbound-message-queue'

// Native WebSockets normally emit close immediately after error or a relay-hello
// refusal; bound the missing-close case so recovery is never left pending.
const RELAY_ERROR_CLOSE_GRACE_MS = 250

export class RelayOuterError extends Error {
  // Distinguish hello refusal from close codes; compare free-text close reasons only by exact value.
  constructor(
    readonly code: number,
    readonly rejectedByRelayHello = false,
    readonly closeReason = ''
  ) {
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
  // Report close reasons separately because hello refusal and close dispatch order is unspecified, and only close names the cause.
  onHostCloseReason?: (reason: RelayHostCloseReason) => void
  // Fired once relay-auth is on the wire: from here the cell owns the wait.
  onOpen?: () => void
  onError: (error: Error) => void
  createSocket?: (url: string) => WebSocket
}

export class MobileRelayE2eeLink {
  private readonly options: MobileRelayE2eeLinkOptions
  private readonly socket: WebSocket
  private readonly channel: MobileE2EEV2PhysicalChannel
  private outerReady = false
  private closed = false
  private rejectedHelloCode: number | null = null
  private closeGraceTimer: ReturnType<typeof setTimeout> | null = null
  private readonly inbound: WsInboundMessageQueue

  constructor(options: MobileRelayE2eeLinkOptions) {
    this.options = options
    this.socket = (options.createSocket ?? ((url) => new WebSocket(url)))(
      relayConnectWebSocketUrl(options.endpoint.cellUrl, options.endpoint.relayHostId)
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
      onAuthenticated: () => {
        latchHostToE2EEV2(options.desktopPublicKeyB64)
        options.onAuthenticated()
      },
      onText: options.onText,
      onBinary: options.onBinary,
      onError: (error) => this.fail(error)
    })
    this.inbound = new WsInboundMessageQueue(
      async (raw) => {
        if (this.closed || this.rejectedHelloCode !== null) {
          return
        }
        if (!this.outerReady) {
          this.acceptHello(raw)
        } else {
          await this.channel.handleMessage(raw)
        }
      },
      (error) => this.fail(asError(error))
    )
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
    this.clearCloseGrace()
    this.inbound.dispose()
    this.channel.dispose()
    this.socket.close()
  }

  private bindSocket(): void {
    this.socket.onopen = () => {
      try {
        this.socket.send(
          JSON.stringify({
            type: 'relay-auth',
            v: 1,
            mode: 'connect',
            credential: this.options.credential
          })
        )
      } catch (error) {
        this.fail(asError(error))
        return
      }
      this.options.onOpen?.()
    }
    this.socket.onmessage = (event) => {
      void this.inbound.enqueue(event.data)
    }
    // `error` is often delivered just before `close`; wait for close so a
    // typed relay code is not replaced by a generic transport error.
    this.socket.onerror = () => {
      if (!this.closed) {
        this.awaitClose()
      }
    }
    this.socket.onclose = (event) => {
      this.clearCloseGrace()
      // Ahead of fail(), which no-ops once a missing close already timed out.
      const hostCloseReason = relayHostCloseReasonFrom(event.reason)
      if (hostCloseReason) {
        this.options.onHostCloseReason?.(hostCloseReason)
      }
      this.fail(
        new RelayOuterError(
          this.rejectedHelloCode ?? (event.code || 1006),
          this.rejectedHelloCode !== null,
          event.reason ?? ''
        )
      )
    }
  }

  // Bound waiting for close reason; dead native sockets may never emit it.
  private awaitClose(): void {
    this.closeGraceTimer ??= setTimeout(() => {
      this.closeGraceTimer = null
      this.fail(
        new RelayOuterError(this.rejectedHelloCode ?? 1006, this.rejectedHelloCode !== null)
      )
    }, RELAY_ERROR_CLOSE_GRACE_MS)
  }

  private clearCloseGrace(): void {
    if (this.closeGraceTimer) {
      clearTimeout(this.closeGraceTimer)
      this.closeGraceTimer = null
    }
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
      // Wait for the following close to preserve the reason needed by recovery.
      this.rejectedHelloCode = parsed.data.code
      this.awaitClose()
      return
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
    this.clearCloseGrace()
    this.inbound.dispose()
    this.channel.dispose()
    this.options.onError(error)
    this.socket.close()
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
