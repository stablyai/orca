import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SshConnection } from '../../ssh/connection/ssh-connection'
import type { SshConnectionManager } from '../../ssh/connection/ssh-connection-manager'
import type { SshConnectionStore } from '../../ssh/targets/ssh-connection-store'
import { SshPortForwardManager } from '../../ssh/port-forwarding/ssh-port-forward'
import type { SshPortForwardProvider } from '../../ssh/port-forwarding/ssh-port-forward-provider'
import { setSshTargetRegistryStore } from '../../ssh/targets/ssh-target-registry'
import { systemBrowserUrlForForwardedLoopback } from '../../ssh/port-forwarding/forwarded-loopback-open-url'
import { setConnectionManager, setPortForwardManager } from './ssh-ipc-context'
import { restorePortForwards } from './ssh-port-forward-persistence'

vi.mock('./ssh-renderer-broadcast', () => ({ broadcastPortForwards: vi.fn() }))

const servers: Server[] = []

function listen(host: string, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((socket) => socket.destroy())
    server.once('error', reject)
    server.listen(port, host, () => {
      servers.push(server)
      resolve(server)
    })
  })
}

function boundPort(server: Server): number {
  const address = server.address()
  return typeof address === 'object' && address ? address.port : 0
}

/** Binds 127.0.0.1 like the real SSH providers, with no SSH behind it. */
const loopbackProvider: SshPortForwardProvider = {
  canHandle: () => true,
  async start(_conn, options) {
    const server = await listen(options.localHost, options.localPort)
    return {
      entry: {
        id: options.id,
        connectionId: options.connectionId,
        localPort: boundPort(server),
        remoteHost: options.remoteHost,
        remotePort: options.remotePort
      },
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
      dispose: () => server.close()
    }
  }
}

afterEach(async () => {
  setPortForwardManager(null)
  setConnectionManager(null)
  setSshTargetRegistryStore(null)
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve)))
  )
})

describe('restorePortForwards', () => {
  it('restores a saved forward whose port another local server holds on [::1]', async () => {
    let ipv6Server: Server
    try {
      ipv6Server = await listen('::1', 0)
    } catch {
      return // No IPv6 loopback on this machine.
    }
    const localPort = boundPort(ipv6Server)
    const conn = { isDisposed: () => false } as unknown as SshConnection
    const manager = new SshPortForwardManager({}, [loopbackProvider])
    const saved = { localPort, remoteHost: 'localhost', remotePort: 3000 }
    setPortForwardManager(manager)
    setConnectionManager({ getConnection: () => conn } as unknown as SshConnectionManager)
    setSshTargetRegistryStore({
      getTarget: () => ({ id: 'target', portForwards: [saved] }),
      updateTarget: vi.fn()
    } as unknown as SshConnectionStore)

    await restorePortForwards('target')

    expect(manager.listForwards('target').map((forward) => forward.localPort)).toEqual([localPort])
    // The system browser would reach the [::1] server through localhost, so the forward opens on 127.0.0.1.
    const opened = await systemBrowserUrlForForwardedLoopback(
      new URL(`http://localhost:${localPort}/app?x=1`)
    )
    expect(opened.toString()).toBe(`http://127.0.0.1:${localPort}/app?x=1`)
    await manager.removeAllForwards('target')
  })
})
