import { Agent } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import { WebSocketServer } from 'ws'
import { relayWebSocketAgent } from '../../network/relay-cloud-proxy-route'
import { CloudRelayTransport } from '../rpc/relay-transport'
import { RelayControlClient } from './relay-control-client'

vi.mock('../../network/relay-cloud-proxy-route', () => ({ relayWebSocketAgent: vi.fn() }))

// Why: both relay sockets must take the proxy-following agent, or a proxied desktop dials direct.
describe('relay websockets use the session proxy agent', () => {
  const servers: WebSocketServer[] = []
  const cleanups: (() => unknown)[] = []

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
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

  async function startServer(): Promise<{ port: number; connected: Promise<string> }> {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    servers.push(server)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('expected TCP relay test server')
    }
    const connected = new Promise<string>((resolve) =>
      server.once('connection', (_socket, request) => resolve(request.url ?? ''))
    )
    return { port: address.port, connected }
  }

  function recordingAgent(): { agent: Agent; dials: ReturnType<typeof vi.spyOn> } {
    const agent = new Agent()
    return { agent, dials: vi.spyOn(agent, 'createConnection') }
  }

  it('dials the control socket through the agent', async () => {
    const { port, connected } = await startServer()
    const { agent, dials } = recordingAgent()
    vi.mocked(relayWebSocketAgent).mockReturnValue(agent)
    const keypair = nacl.box.keyPair()
    const client = new RelayControlClient({
      cellUrl: `http://127.0.0.1:${port}`,
      relayJwt: 'scoped-token',
      relayHostId: 'AbCdEf0123_-xyZ9',
      assignmentEpoch: 1,
      identity: { userId: 'user-1', profileId: 'profile-1', organizationId: 'org-1' },
      keypair: { ...keypair, publicKeyB64: Buffer.from(keypair.publicKey).toString('base64') },
      appVersion: '1.2.3',
      onConnectionOpen: vi.fn(),
      onDrain: vi.fn(),
      onClose: vi.fn()
    })
    cleanups.push(() => client.closeNow())
    void client.connect().catch(() => undefined)

    await connected
    expect(relayWebSocketAgent).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^ws://127\\.0\\.0\\.1:${port}/`))
    )
    expect(dials).toHaveBeenCalled()
  })

  it('dials each mobile data socket through the agent', async () => {
    const { port, connected } = await startServer()
    const { agent, dials } = recordingAgent()
    vi.mocked(relayWebSocketAgent).mockReturnValue(agent)
    const transport = new CloudRelayTransport({
      cellUrl: `http://127.0.0.1:${port}`,
      relayHostId: 'AbCdEf0123_-xyZ9',
      generation: 1
    })
    cleanups.push(() => transport.stop())
    transport.onMessage(vi.fn())
    transport.onConnectionClose(vi.fn())
    await transport.start()
    void transport
      .openConnection({
        connId: 'conn-1',
        connTicket: 'ticket-1',
        kind: 'resume',
        relayDeviceId: 'device-1',
        attachDeadlineMs: 1_000
      })
      .catch(() => undefined)

    await expect(connected).resolves.toBe('/v1/host/data/conn-1')
    expect(relayWebSocketAgent).toHaveBeenCalledWith(`ws://127.0.0.1:${port}/v1/host/data/conn-1`)
    expect(dials).toHaveBeenCalled()
  })
})
