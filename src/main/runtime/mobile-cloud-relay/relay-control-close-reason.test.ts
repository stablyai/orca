import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import { WebSocketServer, type WebSocket } from 'ws'
import { RELAY_HOST_CLOSE_REASON } from '../../../shared/relay-host-close-reason'
import { RelayControlClient } from './relay-control-client'

type ObservedClose = { code: number; reason: string }

describe('RelayControlClient close reason', () => {
  const servers: WebSocketServer[] = []
  const clients: RelayControlClient[] = []

  afterEach(async () => {
    for (const client of clients.splice(0)) {
      client.closeNow()
    }
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            for (const socket of server.clients) {
              socket.terminate()
            }
            server.close(() => resolve())
          })
      )
    )
  })

  async function connectedClient(): Promise<{
    client: RelayControlClient
    closed: Promise<ObservedClose>
  }> {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: false })
    servers.push(server)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('expected TCP relay test server')
    }
    const accepted = new Promise<WebSocket>((resolve) => server.once('connection', resolve))
    const keypair = nacl.box.keyPair()
    const client = new RelayControlClient({
      cellUrl: `http://127.0.0.1:${address.port}`,
      relayJwt: 'scoped-token',
      relayHostId: createHash('sha256').update(keypair.publicKey).digest('base64url').slice(0, 16),
      assignmentEpoch: 1,
      identity: { userId: 'user-1', profileId: 'profile-1', organizationId: 'org-1' },
      keypair: { ...keypair, publicKeyB64: Buffer.from(keypair.publicKey).toString('base64') },
      appVersion: '1.2.3',
      onConnectionOpen: vi.fn(),
      onDrain: vi.fn(),
      onClose: vi.fn()
    })
    clients.push(client)
    // The handshake never completes here; only the transport close matters.
    void client.connect().catch(() => {})
    const socket = await accepted
    // A pong proves the client socket left CONNECTING; closeNow can only send a
    // close frame from OPEN, and that is the state a real sign-out fences from.
    await new Promise<void>((resolve) => {
      socket.once('pong', () => resolve())
      socket.ping()
    })
    const closed = new Promise<ObservedClose>((resolve) => {
      socket.once('close', (code, reason) => resolve({ code, reason: reason.toString() }))
    })
    return { client, closed }
  }

  it('delivers the sign-out reason to the cell', async () => {
    const { client, closed } = await connectedClient()

    client.closeNow(RELAY_HOST_CLOSE_REASON.SIGNED_OUT)

    await expect(closed).resolves.toEqual({
      code: 1000,
      reason: RELAY_HOST_CLOSE_REASON.SIGNED_OUT
    })
  })

  // Every non-auth close keeps today's abrupt terminate, so a cell can never
  // read a quit, a rotation or a sleep as a sign-out.
  it('closes abruptly with no reason when none is given', async () => {
    const { client, closed } = await connectedClient()

    client.closeNow()

    await expect(closed).resolves.toEqual({ code: 1006, reason: '' })
  })
})
