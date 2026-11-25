import { createServer, type Server } from 'node:net'
import { afterEach, describe, expect, it, vi, type TestContext } from 'vitest'
import type { SshConnection } from '../../ssh/connection/ssh-connection'
import type { SshConnectionManager } from '../../ssh/connection/ssh-connection-manager'
import type { SshConnectionStore } from '../../ssh/targets/ssh-connection-store'
import { SshPortForwardManager } from '../../ssh/port-forwarding/ssh-port-forward'
import type { SshPortForwardProvider } from '../../ssh/port-forwarding/ssh-port-forward-provider'
import { setSshTargetRegistryStore } from '../../ssh/targets/ssh-target-registry'
import { systemBrowserUrlForForward } from '../../ports/forwarded-url-system-browser'
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

function close(server: Server): Promise<void> {
  const index = servers.indexOf(server)
  if (index !== -1) {
    servers.splice(index, 1)
  }
  return new Promise((resolve) => server.close(() => resolve()))
}

function boundPort(server: Server): number {
  const address = server.address()
  return typeof address === 'object' && address ? address.port : 0
}

function errorCode(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined
}

/** A port another local server holds on [::1] while 127.0.0.1 is free; skips without IPv6 loopback. */
async function portHeldOnIpv6Only(ctx: TestContext): Promise<number> {
  for (let attempt = 0; attempt < 5; attempt++) {
    let ipv6: Server
    try {
      ipv6 = await listen('::1', 0)
    } catch (error) {
      if (errorCode(error) === 'EADDRNOTAVAIL' || errorCode(error) === 'EAFNOSUPPORT') {
        ctx.skip('No IPv6 loopback on this machine')
      }
      throw error
    }
    const port = boundPort(ipv6)
    try {
      await close(await listen('127.0.0.1', port))
      return port
    } catch (error) {
      // Another process holds the IPv4 half of this number; try a fresh one.
      if (errorCode(error) !== 'EADDRINUSE') {
        throw error
      }
      await close(ipv6)
    }
  }
  throw new Error('No port free on 127.0.0.1 behind a [::1] listener after 5 tries')
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
      close: () => close(server),
      dispose: () => void close(server),
      // Like ssh2: the listener belongs to the connection it started on.
      isLive: (current) => current === conn
    }
  }
}

const conn = { isDisposed: () => false } as unknown as SshConnection

function useSshTarget(saved: {
  localPort: number
  remoteHost: string
  remotePort: number
}): SshPortForwardManager {
  const manager = new SshPortForwardManager({}, [loopbackProvider])
  setPortForwardManager(manager)
  setConnectionManager({ getConnection: () => conn } as unknown as SshConnectionManager)
  setSshTargetRegistryStore({
    getTarget: () => ({ id: 'target', portForwards: [saved] }),
    updateTarget: vi.fn()
  } as unknown as SshConnectionStore)
  return manager
}

afterEach(async () => {
  setPortForwardManager(null)
  setConnectionManager(null)
  setSshTargetRegistryStore(null)
  await Promise.all(servers.splice(0).map((server) => new Promise((r) => server.close(r))))
})

describe('SSH forwards beside a local [::1] server on the same port', () => {
  it('restores the saved forward on 127.0.0.1', async (ctx) => {
    const localPort = await portHeldOnIpv6Only(ctx)
    const manager = useSshTarget({ localPort, remoteHost: 'localhost', remotePort: 3000 })

    await restorePortForwards('target')

    expect(manager.listForwards('target').map((forward) => forward.localPort)).toEqual([localPort])
  })

  it('opens that forward on 127.0.0.1, only while it is live and maps the same port', async (ctx) => {
    const localPort = await portHeldOnIpv6Only(ctx)
    const manager = useSshTarget({ localPort, remoteHost: 'localhost', remotePort: 3000 })
    const forward = await manager.addForward('target', conn, localPort, 'localhost', 3000)
    const request = {
      url: `http://localhost:${localPort}/app?x=1`,
      forwardKind: 'ssh' as const,
      connectionId: 'target',
      forwardId: forward.id,
      localPort,
      remoteHost: 'localhost',
      remotePort: 3000
    }

    const opened = await systemBrowserUrlForForward(request)
    expect(opened?.url.toString()).toBe(`http://127.0.0.1:${localPort}/app?x=1`)
    expect(opened?.movedToIpv4).toBe(true)
    // An edit to another remote port, or another kind's forward with this ID, is not this forward.
    expect(await systemBrowserUrlForForward({ ...request, remotePort: 4000 })).toBeNull()
    expect(await systemBrowserUrlForForward({ ...request, forwardKind: 'paired' })).toBeNull()
    // A browser treats a root-dot name as localhost too.
    const rootDot = await systemBrowserUrlForForward({
      ...request,
      url: `http://app.localhost.:${localPort}/`
    })
    expect(rootDot?.url.toString()).toBe(`http://127.0.0.1:${localPort}/`)
    // A reconnect leaves the listener on its old connection; a disconnect disposes the session.
    for (const current of [{ isDisposed: () => false }, { isDisposed: () => true }]) {
      setConnectionManager({ getConnection: () => current } as unknown as SshConnectionManager)
      expect(await systemBrowserUrlForForward(request)).toBeNull()
    }
  })
})
