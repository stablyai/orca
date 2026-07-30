import { afterEach, describe, expect, it } from 'vitest'
import type { WebSocketServer } from 'ws'
import { PeerClientService } from './peer-client-service'
import { generateKeyPair, publicKeyToBase64 } from '../../shared/e2ee-crypto'
import { encodePairingOffer } from '../../shared/pairing'
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
})
