import { once } from 'node:events'
import { connect } from 'node:net'
import { RemoteBrowserSocksServer } from '../browser/network/tunnels/remote-browser-socks-server'

export async function createSocksProxy(allowedPorts: Set<number>) {
  const hosts = new Set<string>()
  const server = new RemoteBrowserSocksServer({
    open: async ({ host, port }) => {
      if (!allowedPorts.has(port)) {
        throw new Error('Unexpected proxy destination')
      }
      hosts.add(host)
      const socket = connect(port, '127.0.0.1')
      await once(socket, 'connect')
      return socket
    }
  })
  const { port } = await server.listen()
  return { address: `127.0.0.1:${port}`, hosts, close: () => server.close() }
}
