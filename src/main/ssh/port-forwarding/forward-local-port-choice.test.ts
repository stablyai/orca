import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { PortForwardEntry } from '../../../shared/remote-runtime/ssh/ssh-types'
import { addForwardOnFreeLocalPort } from './forward-local-port-choice'

const servers: Server[] = []

function listen(host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy())
    server.once('error', reject)
    server.listen(port, host, () => {
      servers.push(server)
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : port)
    })
  })
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))
  )
})

describe('addForwardOnFreeLocalPort', () => {
  // A browser tries [::1] first for localhost, so a local server there would get the forwarded page's traffic.
  it('skips a port another local server answers on [::1]', async () => {
    let taken: number
    try {
      taken = await listen('::1', 0)
    } catch {
      return // No IPv6 loopback on this machine.
    }
    const tried: number[] = []
    const entry = await addForwardOnFreeLocalPort(
      taken,
      async (localPort) => {
        tried.push(localPort)
        const port = await listen('127.0.0.1', localPort)
        const entry: PortForwardEntry = {
          id: `pf-${port}`,
          connectionId: 'target',
          localPort: port,
          remoteHost: 'localhost',
          remotePort: taken
        }
        return entry
      },
      async () => undefined,
      false
    )
    expect(tried).not.toContain(taken)
    expect(entry.localPort).not.toBe(taken)
  })
})
