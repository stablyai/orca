import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocketClient, { WebSocketServer, type WebSocket } from 'ws'
import { CloudRelayTransport } from './relay-transport'

function nextMessage(ws: WebSocket): Promise<{ data: Buffer; isBinary: boolean }> {
  return new Promise((resolve) => {
    ws.once('message', (data, isBinary) => resolve({ data: Buffer.from(data as Buffer), isBinary }))
  })
}

describe('CloudRelayTransport', () => {
  const servers: WebSocketServer[] = []
  const transports: CloudRelayTransport[] = []

  afterEach(async () => {
    await Promise.all(transports.splice(0).map((transport) => transport.stop()))
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

  it('authenticates one query-free host-data socket and forwards messages verbatim', async () => {
    const server = new WebSocketServer({ port: 0, perMessageDeflate: false })
    servers.push(server)
    await new Promise<void>((resolve) => server.once('listening', resolve))
    const address = server.address()
    if (typeof address === 'string' || address === null) {
      throw new Error('expected TCP relay test server')
    }
    const accepted = new Promise<{ socket: WebSocket; path: string }>((resolve) => {
      server.once('connection', (socket, request) => resolve({ socket, path: request.url ?? '' }))
    })
    let clientSocket: WebSocketClient | null = null
    const onConnectionClosed = vi.fn()
    const transport = new CloudRelayTransport({
      cellUrl: `http://127.0.0.1:${address.port}`,
      relayHostId: 'AbCdEf0123_-xyZ9',
      generation: 7,
      createSocket: (url) => {
        clientSocket = new WebSocketClient(url, { perMessageDeflate: false })
        return clientSocket
      },
      onConnectionClosed
    })
    transports.push(transport)
    const received: (string | Uint8Array<ArrayBufferLike>)[] = []
    transport.onMessage((message) => received.push(message))
    transport.onConnectionClose(vi.fn())
    await transport.start()
    const opening = transport.openConnection({
      connId: 'conn/with spaces',
      connTicket: 'ticket-1',
      kind: 'resume',
      relayDeviceId: 'device-1',
      attachDeadlineMs: 1_000
    })
    const { socket, path } = await accepted
    const auth = await nextMessage(socket)
    await opening

    expect(path).toBe('/v1/host/data/conn%2Fwith%20spaces')
    expect(auth.isBinary).toBe(false)
    expect(JSON.parse(auth.data.toString())).toEqual({
      type: 'host-data-auth',
      v: 1,
      connTicket: 'ticket-1',
      generation: 7
    })
    socket.send('e2ee-hello')
    socket.send(Buffer.from([1, 2, 3]), { binary: true })
    await vi.waitFor(() => expect(received).toHaveLength(2))
    expect(received[0]).toBe('e2ee-hello')
    expect(received[1]).toEqual(new Uint8Array([1, 2, 3]))

    expect(clientSocket).not.toBeNull()
    const metadata = transport.metadataFor(clientSocket!)
    expect(metadata).toEqual({
      transport: 'relay',
      relayHostId: 'AbCdEf0123_-xyZ9',
      relayDeviceId: 'device-1',
      basisConnId: 'conn/with spaces',
      credentialKind: 'resume'
    })
    socket.close()
    await vi.waitFor(() => expect(onConnectionClosed).toHaveBeenCalledWith('conn/with spaces'))
  })

  it('rejects non-origin cell URLs before opening a socket', () => {
    expect(
      () =>
        new CloudRelayTransport({
          cellUrl: 'https://relay.example/path?credential=forbidden',
          relayHostId: 'AbCdEf0123_-xyZ9',
          generation: 1
        })
    ).toThrow('relay_cell_url_must_be_an_origin')
  })
})
