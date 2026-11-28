import { once } from 'node:events'
import { Duplex, PassThrough } from 'node:stream'
import { expect, it } from 'vitest'
import { SystemSshSocksClientSocket } from './system-ssh-socks-client-socket'

it('delivers destination bytes coalesced with the SOCKS connect reply', async () => {
  const incoming = new PassThrough()
  const outgoing = new PassThrough()
  const transport = Duplex.from({ readable: incoming, writable: outgoing })
  const socket = new SystemSshSocksClientSocket(
    { host: 'destination.test', port: 443 },
    async () => transport
  )
  socket.on('error', () => {})
  const connected = once(socket, 'connect')
  try {
    await once(outgoing, 'data')
    const connectRequest = once(outgoing, 'data')
    incoming.write(Buffer.from([5, 0]))
    await connectRequest
    const data = once(socket, 'data')
    const payload = Buffer.alloc(4_096, 0x61)
    incoming.write(Buffer.concat([Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 1, 187]), payload]))
    const [, [received]] = await Promise.all([connected, data])
    expect(Buffer.from(received)).toEqual(payload)
  } finally {
    socket.destroy()
  }
})
