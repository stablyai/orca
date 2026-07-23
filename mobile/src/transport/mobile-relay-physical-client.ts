import type { PairingRelay } from '../../../src/shared/mobile-relay-pairing-offer'
import { RelayPhoneHelloSchema } from '../../../src/shared/mobile-relay-phone-protocol'
import { MobileE2EEV2ClientSession } from './mobile-e2ee-v2-client-session'
import { MobileE2EEV2PhysicalChannel } from './mobile-e2ee-v2-physical-channel'
import { assertMobileInboundFrameSize } from './mobile-inbound-frame-queue'
import { stringifyMobileOutboundJson } from './mobile-outbound-json'
import { isRpcResponse } from './rpc-response-shape'
import type { RpcResponse } from './types'
import { websocketPayloadToUint8 } from './websocket-payload-bytes'
import {
  isMobileJsonStructureCapacityError,
  parseMobileJsonTextWithinLimits
} from './mobile-json-text-admission'
export { RelayOuterError } from './mobile-relay-e2ee-link'
import { RelayOuterError } from './mobile-relay-e2ee-link'

type PendingRequest = {
  resolve: (response: RpcResponse) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export type PairingCandidateClient = {
  sendRequest(method: string, params?: unknown): Promise<RpcResponse>
  close(): void
}

export function connectMobileRelayForPairing(args: {
  relay: PairingRelay
  deviceToken: string
  desktopPublicKeyB64: string
  credential?: string
  expectedCredentialKind?: 'invite' | 'resume'
  requestTimeoutMs?: number
  createSocket?: (url: string) => WebSocket
}): PairingCandidateClient {
  const requestTimeoutMs = args.requestTimeoutMs ?? 30_000
  const socketUrl = relayPhoneWebSocketUrl(args.relay)
  const socket = (args.createSocket ?? ((url) => new WebSocket(url)))(socketUrl)
  const session = MobileE2EEV2ClientSession.create({
    desktopPublicKeyB64: args.desktopPublicKeyB64,
    transport: 'relay',
    relayHostId: args.relay.relayHostId
  })
  const pending = new Map<string, PendingRequest>()
  let requestCounter = 0
  let closed = false
  let outerReady = false
  let authenticated = false
  let resolveAuthenticated!: () => void
  let rejectAuthenticated!: (error: Error) => void
  const authenticatedPromise = new Promise<void>((resolve, reject) => {
    resolveAuthenticated = resolve
    rejectAuthenticated = reject
  })
  let channel: MobileE2EEV2PhysicalChannel
  try {
    channel = new MobileE2EEV2PhysicalChannel({
      session,
      socket,
      deviceToken: args.deviceToken,
      decodeBinary: websocketPayloadToUint8,
      onAuthenticated: () => {
        authenticated = true
        resolveAuthenticated()
      },
      onText: (plaintext) => {
        let value: unknown
        try {
          value = parseMobileJsonTextWithinLimits(plaintext)
        } catch (error) {
          if (isMobileJsonStructureCapacityError(error)) {
            throw error
          }
          return
        }
        if (!isRpcResponse(value)) {
          return
        }
        const request = pending.get(value.id)
        if (request) {
          clearTimeout(request.timer)
          pending.delete(value.id)
          request.resolve(value)
        }
      },
      onBinary: () => {},
      onError: fail
    })
  } catch (error) {
    socket.close()
    throw error
  }

  socket.onopen = () => {
    socket.send(
      JSON.stringify({
        type: 'relay-auth',
        v: 1,
        mode: 'connect',
        credential: args.credential ?? args.relay.inviteToken
      })
    )
  }
  socket.onmessage = (event) => {
    if (closed) {
      return
    }
    try {
      if (!outerReady) {
        assertMobileInboundFrameSize(event.data, 'relay hello frame too large')
        acceptRelayHello(event.data)
        return
      }
      void channel.handleMessage(event.data)
    } catch (error) {
      fail(asError(error))
    }
  }
  socket.onerror = () => fail(new Error('relay transport error'))
  socket.onclose = (event) => {
    channel.socketClosed()
    fail(new RelayOuterError(event.code || 1006))
  }

  function acceptRelayHello(raw: unknown): void {
    if (typeof raw !== 'string') {
      throw new Error('expected plaintext relay hello')
    }
    let value: unknown
    try {
      value = parseMobileJsonTextWithinLimits(raw)
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
    if (parsed.data.credentialKind !== (args.expectedCredentialKind ?? 'invite')) {
      throw new Error('relay credential resolved as an unexpected credential kind')
    }
    outerReady = true
    channel.start()
  }

  function fail(error: Error): void {
    if (closed) {
      return
    }
    closed = true
    channel.dispose()
    rejectAuthenticated(error)
    for (const request of pending.values()) {
      clearTimeout(request.timer)
      request.reject(error)
    }
    pending.clear()
    socket.close()
  }

  return {
    async sendRequest(method, params) {
      await authenticatedPromise
      if (closed || !authenticated) {
        throw new Error('relay pairing client closed')
      }
      const id = `relay-pair-${++requestCounter}`
      return new Promise<RpcResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`relay pairing RPC timed out: ${method}`))
        }, requestTimeoutMs)
        pending.set(id, { resolve, reject, timer })
        let serialized: string
        try {
          serialized = stringifyMobileOutboundJson({
            id,
            deviceToken: args.deviceToken,
            method,
            params
          })
        } catch {
          clearTimeout(timer)
          pending.delete(id)
          reject(new Error('relay RPC request is too large'))
          return
        }
        if (!channel.sendText(serialized)) {
          clearTimeout(timer)
          pending.delete(id)
          reject(new Error('relay E2EE channel not ready'))
        }
      })
    },
    close: () => fail(new Error('relay pairing client closed'))
  }
}

export function relayPhoneWebSocketUrl(relay: PairingRelay): string {
  const url = new URL(relay.cellUrl)
  url.protocol = 'wss:'
  url.pathname = `/v1/connect/${encodeURIComponent(relay.relayHostId)}`
  return url.toString()
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
