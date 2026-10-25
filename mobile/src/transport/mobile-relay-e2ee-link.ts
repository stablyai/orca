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

// Native WebSockets normally emit close immediately after error or a relay-hello
// refusal; bound the missing-close case so recovery is never left pending.
const RELAY_ERROR_CLOSE_GRACE_MS = 250

export class RelayOuterError extends Error {
  // rejectedByRelayHello: the relay refused in a relay-hello frame, not just a close code.
  // closeReason: the close frame's reason text; free text, so only compare exact values.
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
  // The cell's account of why the desktop is absent, read off the close frame.
  // Reported separately from onError because a rejection is delivered as both a
  // relay-hello and a close, and which one the runtime dispatches first is not
  // ordered — only the close carries the reason, and it must not be lost to
  // that race.
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
  private inboundChain: Promise<void> = Promise.resolve()

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
      this.inboundChain = this.inboundChain
        .then(async () => {
          if (this.closed || this.rejectedHelloCode !== null) {
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

  // Waits briefly for the close frame, which alone carries the reason, before
  // failing with what is known; a dead socket may never deliver it.
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
      // Why: the cell closes right behind a refusal, and only that close carries
      // the reason recovery needs; failing now would drop it.
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
    this.channel.dispose()
    this.options.onError(error)
    this.socket.close()
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
