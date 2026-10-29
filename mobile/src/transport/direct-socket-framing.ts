import {
  createPairedE2EEClientHandshake,
  PairedE2EEDowngradeError,
  type PairedE2EEFraming
} from '../../../src/shared/paired-e2ee-client-handshake'
import { MOBILE_PAIRED_E2EE_PRIMITIVES } from './mobile-paired-e2ee-primitives'
import { MobileE2EEV2ClientSession } from './mobile-e2ee-v2-client-session'
import {
  MobileE2EEAuthenticationError,
  MobileE2EEV2PhysicalChannel
} from './mobile-e2ee-v2-physical-channel'
import type { ConnectionLogEmitter } from './types'
import { websocketPayloadToUint8 } from './websocket-payload-bytes'

export type DirectSocketFramingEvents = {
  onReadyAccepted: () => void
  onAuthenticated: () => void
  onText: (plaintext: string) => void
  onBinary: (plaintext: Uint8Array) => void
  onAuthRejected: () => void
  onProtocolError: (error: Error) => void
}

export type DirectSocketFraming = {
  // Throws when the hello cannot be written.
  start: () => void
  handleInbound: (raw: unknown) => void
  // false = not ready yet; throws when the socket write fails.
  sendText: (plaintext: string) => boolean
  dispose: () => void
}

export function createDirectSocketFraming(args: {
  framing: PairedE2EEFraming
  mayUseLegacy: () => boolean
  socket: WebSocket
  serverPublicKeyB64: string
  deviceToken: string
  emitLog: ConnectionLogEmitter
  events: DirectSocketFramingEvents
}): DirectSocketFraming {
  return args.framing === 'v2' ? createV2Framing(args) : createLegacyFraming(args)
}

function createV2Framing(args: Parameters<typeof createDirectSocketFraming>[0]) {
  const { events } = args
  let authenticated = false
  const channel = new MobileE2EEV2PhysicalChannel({
    session: MobileE2EEV2ClientSession.create({
      desktopPublicKeyB64: args.serverPublicKeyB64,
      transport: 'direct'
    }),
    socket: args.socket,
    deviceToken: args.deviceToken,
    decodeBinary: websocketPayloadToUint8,
    onReadyAccepted: () => {
      args.emitLog('success', 'Received e2ee_ready (v2)', 'Sending device token')
      events.onReadyAccepted()
    },
    onAuthenticated: () => {
      authenticated = true
      events.onAuthenticated()
    },
    onText: events.onText,
    onBinary: events.onBinary,
    // Count handshake failures against auth retries; a legacy reply to a v2 hello must never trigger downgrade.
    onError: (error) =>
      error instanceof MobileE2EEAuthenticationError || !authenticated
        ? events.onAuthRejected()
        : events.onProtocolError(error)
  })
  return {
    start: () => {
      channel.start()
      args.emitLog('info', 'Sent e2ee_hello (v2)', 'Awaiting server e2ee_ready')
    },
    handleInbound: (raw: unknown) => void channel.handleMessage(raw),
    sendText: (plaintext: string) => channel.sendText(plaintext),
    dispose: () => channel.dispose()
  }
}

function createLegacyFraming(args: Parameters<typeof createDirectSocketFraming>[0]) {
  const { events, socket } = args
  const handshake = createPairedE2EEClientHandshake({
    primitives: MOBILE_PAIRED_E2EE_PRIMITIVES,
    hostPublicKeyB64: args.serverPublicKeyB64,
    framing: 'legacy',
    legacyGate: { mayUseLegacy: args.mayUseLegacy }
  })
  let keyed = false
  let authenticated = false
  let disposed = false

  const sendText = (plaintext: string): boolean => {
    if (!keyed || disposed) {
      return false
    }
    socket.send(handshake.channel.sealText(plaintext))
    return true
  }

  const sendAuth = async (): Promise<void> => {
    try {
      const frame = await handshake.sealAuth({ kind: 'token', deviceToken: args.deviceToken })
      if (disposed) {
        return
      }
      // Why: another socket may have latched this host to v2 while the auth step ran.
      if (!args.mayUseLegacy()) {
        throw new PairedE2EEDowngradeError('auth')
      }
      socket.send(frame)
    } catch (error) {
      if (!disposed) {
        events.onProtocolError(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }

  const handleHandshake = (raw: string): void => {
    const ready = handshake.acceptReadyText(raw)
    if (ready === 'downgrade_refused') {
      events.onProtocolError(new PairedE2EEDowngradeError('auth'))
      return
    }
    if (ready === 'accepted') {
      args.emitLog('success', 'Received e2ee_ready', 'Sending device token')
      events.onReadyAccepted()
      void sendAuth()
      return
    }
    const plaintext = keyed ? handshake.channel.openText(raw) : null
    if (plaintext === null) {
      return
    }
    const reply = handshake.classifyAuthReply(plaintext)
    if (reply.kind === 'authenticated') {
      authenticated = true
      events.onAuthenticated()
    } else if (
      reply.kind === 'rejected' &&
      (reply.type === 'e2ee_error' || reply.errorCode === 'unauthorized')
    ) {
      console.log('[net] e2ee auth FAILED', { msgType: reply.type, code: reply.errorCode })
      events.onAuthRejected()
    }
  }

  const handleInbound = async (raw: unknown): Promise<void> => {
    if (typeof raw === 'string') {
      if (!authenticated) {
        handleHandshake(raw)
        return
      }
      const plaintext = keyed && !disposed ? handshake.channel.openText(raw) : null
      if (plaintext !== null) {
        events.onText(plaintext)
      }
      return
    }
    if (!authenticated) {
      return
    }
    const bytes = await websocketPayloadToUint8(raw)
    if (disposed || !bytes || !keyed) {
      return
    }
    const plaintext = handshake.channel.openBinary(bytes)
    if (plaintext) {
      events.onBinary(plaintext)
    }
  }

  return {
    start: () => {
      socket.send(handshake.helloText())
      args.emitLog('info', 'Sent e2ee_hello', 'Awaiting server e2ee_ready')
      keyed = true
    },
    handleInbound: (raw: unknown) => void handleInbound(raw),
    sendText,
    dispose: () => {
      disposed = true
    }
  }
}
