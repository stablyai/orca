import { once } from 'node:events'
import { createServer, type AddressInfo, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { SystemSshSocksClientSocket } from './system-ssh-socks-client-socket'

const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  )
})

describe('SystemSshSocksClientSocket', () => {
  it('carries the exact destination domain through the internal SOCKS handshake', async () => {
    let accepted: Socket | undefined
    let request: Buffer | undefined
    const server = createServer((socket) => {
      accepted = socket
      socket.once('data', (greeting) => {
        expect([...greeting]).toEqual([5, 1, 0])
        socket.write(new Uint8Array([5, 0]))
        socket.once('data', (connectRequest) => {
          request =
            typeof connectRequest === 'string' ? Buffer.from(connectRequest) : connectRequest
          socket.write(new Uint8Array([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
        })
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    const socket = new SystemSshSocksClientSocket(address.port, {
      host: 'split-horizon.internal',
      port: 8443
    })
    socket.on('error', () => {})
    await once(socket, 'connect')

    const host = new TextEncoder().encode('split-horizon.internal')
    expect(request).toEqual(
      Buffer.from([5, 1, 0, 3, host.byteLength, ...host, (8443 >>> 8) & 0xff, 8443 & 0xff])
    )
    socket.destroy()
    accepted?.destroy()
  })
})
