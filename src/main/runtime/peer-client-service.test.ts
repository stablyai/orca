import { afterEach, describe, expect, it } from 'vitest'
import type { WebSocket, WebSocketServer } from 'ws'
import type { Socket } from 'node:net'
import { PeerClientService } from './peer-client-service'
import { generateKeyPair, publicKeyToBase64 } from '../../shared/e2ee-crypto'
import { encodePairingOffer } from '../../shared/pairing'
import {
  PEER_HOST_DISCONNECTED_CLOSE_CODE,
  PEER_HOSTING_DISABLED_CLOSE_CODE
} from '../../shared/peer-connection-close-codes'
import { E2EEChannel } from './rpc/e2ee-channel'
import {
  serveOnePeerConnection,
  startPeerTestServer as startServer,
  waitForPeerClientState as waitForState
} from './peer-client-test-harness'

describe('PeerClientService', () => {
  const servers: WebSocketServer[] = []
  const services: PeerClientService[] = []

  afterEach(async () => {
    for (const service of services.splice(0)) {
      service.destroy()
    }
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            for (const client of server.clients) {
              client.terminate()
            }
            server.close(() => resolve())
          })
      )
    )
  })

  function makePeerOffer(
    endpoint: string,
    serverKeys: ReturnType<typeof generateKeyPair>,
    deviceToken: string
  ) {
    return encodePairingOffer({
      v: 2,
      endpoint,
      deviceToken,
      publicKeyB64: publicKeyToBase64(serverKeys.publicKey),
      scope: 'peer'
    })
  }

  it('rejects a pairing code minted with a non-peer scope', () => {
    const service = new PeerClientService()
    services.push(service)
    const serverKeys = generateKeyPair()
    const code = encodePairingOffer({
      v: 2,
      endpoint: 'ws://127.0.0.1:1',
      deviceToken: 'token',
      publicKeyB64: publicKeyToBase64(serverKeys.publicKey),
      scope: 'mobile'
    })

    const result = service.connect(code)

    expect(result).toEqual({ ok: false, reason: 'not_a_peer_pairing_code' })
    expect(service.getStatus().state).toBe('closed')
  })

  it('rejects unparsable pairing input without touching network state', () => {
    const service = new PeerClientService()
    services.push(service)

    const result = service.connect('not a pairing code')

    expect(result).toEqual({ ok: false, reason: 'invalid_pairing_code' })
  })

  it('completes the E2EE handshake against a real runtime-rpc server and lists host terminals', async () => {
    const { server, endpoint } = await startServer()
    servers.push(server)
    const serverKeys = generateKeyPair()
    serveOnePeerConnection(server, serverKeys, 'peer-token-abc')

    const service = new PeerClientService()
    services.push(service)
    const code = makePeerOffer(endpoint, serverKeys, 'peer-token-abc')

    expect(service.connect(code)).toEqual({ ok: true })
    await waitForState(service, 'connected')

    const terminals = await service.listHostTerminals()
    expect(terminals).toEqual({ terminals: [] })

    service.disconnect()
    await waitForState(service, 'closed')
  })

  it('closes to a terminal state on an invalid device token instead of retrying forever', async () => {
    const { server, endpoint } = await startServer()
    servers.push(server)
    const serverKeys = generateKeyPair()
    serveOnePeerConnection(server, serverKeys, 'expected-token')

    const service = new PeerClientService()
    services.push(service)
    const code = makePeerOffer(endpoint, serverKeys, 'wrong-token')

    expect(service.connect(code)).toEqual({ ok: true })
    await waitForState(service, 'closed')

    expect(service.getStatus().lastErrorReason).toBe('unauthorized')
  })

  it('surfaces the socket-level failure cause while waiting to reconnect', async () => {
    // Why: a closed port stands in for any transport failure (EHOSTUNREACH,
    // ECONNREFUSED) — without the captured cause these collapse into a bare
    // close code and lastErrorReason stays null, showing an unexplained
    // "Reconnecting".
    const { server, endpoint } = await startServer()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const serverKeys = generateKeyPair()

    const service = new PeerClientService()
    services.push(service)
    const code = makePeerOffer(endpoint, serverKeys, 'any-token')

    expect(service.connect(code)).toEqual({ ok: true })
    await waitForState(service, 'reconnect-wait')

    expect(service.getStatus().lastErrorReason).toMatch(/ECONNREFUSED/)
  })

  it('disarms the pending reconnect timer when connecting to a new host', async () => {
    // Why: a timer armed for the previous host would fire after this connect and
    // open a second socket, which the host closes as a duplicate connection —
    // latching the brand-new session to closed.
    const { server, endpoint } = await startServer()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    const serverKeys = generateKeyPair()

    const service = new PeerClientService()
    services.push(service)
    const code = makePeerOffer(endpoint, serverKeys, 'any-token')

    expect(service.connect(code)).toEqual({ ok: true })
    await waitForState(service, 'reconnect-wait')

    expect(service.connect(code)).toEqual({ ok: true })
    const timer = (service as unknown as { reconnectTimer: unknown }).reconnectTimer
    expect(timer).toBeNull()
  })

  it('survives reconnecting while the previous socket is still establishing', async () => {
    // Why: a TCP server that accepts but never answers the WS upgrade keeps the
    // socket in CONNECTING — the state a macOS local-network permission prompt
    // holds it in. Re-entering a code then tears that socket down, and ws emits
    // an error from terminate() that must not escape as an uncaught exception.
    const net = await import('node:net')
    // Why: the silent server's accepted sockets never close on their own, so
    // they must be destroyed explicitly or server.close() waits forever.
    const acceptedSockets: Socket[] = []
    const tcpServer = net.createServer((socket) => acceptedSockets.push(socket))
    await new Promise<void>((resolve) => tcpServer.listen(0, '127.0.0.1', resolve))
    const address = tcpServer.address()
    if (typeof address === 'string' || address === null) {
      throw new Error('expected TCP test server')
    }
    const serverKeys = generateKeyPair()
    const code = makePeerOffer(`ws://127.0.0.1:${address.port}`, serverKeys, 'any-token')

    const service = new PeerClientService()
    services.push(service)
    expect(service.connect(code)).toEqual({ ok: true })
    // Why: give the socket a beat to enter CONNECTING against the silent server.
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(() => service.connect(code)).not.toThrow()

    service.destroy()
    for (const socket of acceptedSockets) {
      socket.destroy()
    }
    await new Promise<void>((resolve) => tcpServer.close(() => resolve()))
  })

  it('latches closed with host_disabled on the hosting-disabled close code', async () => {
    const { server, endpoint } = await startServer()
    servers.push(server)
    const serverKeys = generateKeyPair()
    // Why: mirrors serveOnePeerConnection but closes with the hosting-disabled
    // code the moment the handshake would otherwise complete, standing in for
    // runtime-rpc.ts's onReady rejection when the host toggle is off.
    server.once('connection', (ws: WebSocket) => {
      const channel = new E2EEChannel(ws, {
        serverSecretKey: serverKeys.secretKey,
        resolveAuthenticatedDevice: () => ({
          deviceId: 'peer-device-1',
          deviceToken: 'peer-token-abc',
          scope: 'peer'
        }),
        onReady: () => ws.close(PEER_HOSTING_DISABLED_CLOSE_CODE, 'Peer hosting disabled'),
        onError: (code, reason) => ws.close(code, reason)
      })
      ws.on('message', (raw, isBinary) =>
        channel.handleRawMessage(isBinary ? (raw as Buffer) : raw.toString())
      )
      ws.on('close', () => channel.destroy())
    })

    const service = new PeerClientService()
    services.push(service)
    const code = makePeerOffer(endpoint, serverKeys, 'peer-token-abc')

    expect(service.connect(code)).toEqual({ ok: true })
    await waitForState(service, 'closed')

    expect(service.getStatus().lastErrorReason).toBe('host_disabled')
    // Why: same guarantee as the duplicate_connection case — a repeat
    // rejection must not spin the reconnect budget.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(service.getStatus().state).toBe('closed')
  })

  it('latches closed with host_disconnected instead of reconnecting when the host disconnects it', async () => {
    const { server, endpoint } = await startServer()
    servers.push(server)
    const serverKeys = generateKeyPair()
    // Why: stands in for runtime-rpc.ts's disconnectPeerClient, which closes an
    // established connection with the host-disconnected code.
    server.once('connection', (ws: WebSocket) => {
      const channel = new E2EEChannel(ws, {
        serverSecretKey: serverKeys.secretKey,
        resolveAuthenticatedDevice: () => ({
          deviceId: 'peer-device-1',
          deviceToken: 'peer-token-abc',
          scope: 'peer'
        }),
        onReady: () => ws.close(PEER_HOST_DISCONNECTED_CLOSE_CODE, 'Host disconnected this client'),
        onError: (code, reason) => ws.close(code, reason)
      })
      ws.on('message', (raw, isBinary) =>
        channel.handleRawMessage(isBinary ? (raw as Buffer) : raw.toString())
      )
      ws.on('close', () => channel.destroy())
    })

    const service = new PeerClientService()
    services.push(service)
    const code = makePeerOffer(endpoint, serverKeys, 'peer-token-abc')

    expect(service.connect(code)).toEqual({ ok: true })
    await waitForState(service, 'closed')

    expect(service.getStatus().lastErrorReason).toBe('host_disconnected')
    // Why: reconnecting would undo the host's disconnect a second later.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(service.getStatus().state).toBe('closed')
  })
})
