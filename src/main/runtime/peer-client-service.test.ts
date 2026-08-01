import { afterEach, describe, expect, it } from 'vitest'
import type { WebSocket, WebSocketServer } from 'ws'
import { PeerClientService } from './peer-client-service'
import { generateKeyPair, publicKeyToBase64 } from '../../shared/e2ee-crypto'
import { encodePairingOffer } from '../../shared/pairing'
import { PEER_HOSTING_DISABLED_CLOSE_CODE } from '../../shared/peer-connection-close-codes'
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
})
