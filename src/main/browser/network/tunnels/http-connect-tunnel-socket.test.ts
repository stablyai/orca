import { once } from 'node:events'
import { Duplex, PassThrough } from 'node:stream'
import { expect, it } from 'vitest'
import { HttpConnectTunnelSocket } from './http-connect-tunnel-socket'

it('waits through interim HTTP responses and preserves the final tunnel payload', async () => {
  const incoming = new PassThrough()
  const outgoing = new PassThrough()
  const transport = Duplex.from({ readable: incoming, writable: outgoing })
  const socket = new HttpConnectTunnelSocket(
    new URL('http://proxy.test:8080'),
    { host: 'destination.test', port: 443 },
    async () => transport
  )
  socket.on('error', () => {})
  const connected = once(socket, 'connect')
  try {
    await once(outgoing, 'data')
    const data = once(socket, 'data')
    incoming.write('HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 103 Early Hints\r\n')
    incoming.write('\r\nHTTP/1.1 200 Connection Established\r\n\r\ntunnel bytes')
    const [, [received]] = await Promise.all([connected, data])
    expect(Buffer.from(received).toString()).toBe('tunnel bytes')
  } finally {
    socket.destroy()
  }
})
