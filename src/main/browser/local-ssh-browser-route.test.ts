import { EventEmitter, once } from 'node:events'
import { connect, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  BrowserNetworkExecutionRoute,
  BrowserNetworkExecutionRouteContext
} from './browser-network-execution-route'
import type { BrowserNetworkTunnelSocket } from './browser-network-tunnel-stream-state'
import {
  closeAllLocalSshBrowserRoutes,
  closeLocalSshBrowserRouteForTarget,
  LocalSshBrowserRoute,
  retainLocalSshBrowserRoute
} from './local-ssh-browser-route'

class FakeTunnelSocket extends EventEmitter implements BrowserNetworkTunnelSocket {
  destroyed = false
  constructor(private readonly behavior: 'echo' | 'never-connect' = 'echo') {
    super()
    if (behavior === 'echo') {
      queueMicrotask(() => {
        if (!this.destroyed) {
          this.emit('connect')
        }
      })
    }
  }
  setNoDelay(): this {
    return this
  }
  pause(): this {
    return this
  }
  resume(): this {
    return this
  }
  write(bytes: Uint8Array, callback?: () => void): boolean {
    if (this.behavior === 'echo' && !this.destroyed) {
      queueMicrotask(() => this.emit('data', bytes))
    }
    callback?.()
    return true
  }
  end(): this {
    return this
  }
  destroy(): this {
    if (!this.destroyed) {
      this.destroyed = true
      this.emit('close')
    }
    return this
  }
}

type FakeRoute = BrowserNetworkExecutionRoute & {
  invalidate: () => void
  dials: { host: string; port: number }[]
}

function fakeExecutionRoute(key: string): FakeRoute {
  let valid = true
  let invalidated: () => void = () => {}
  const whenInvalidated = new Promise<void>((resolve) => {
    invalidated = resolve
  })
  const dials: { host: string; port: number }[] = []
  return {
    key,
    dials,
    connect: (target) => {
      dials.push({ host: target.host, port: target.port })
      return new FakeTunnelSocket()
    },
    whenInvalidated,
    isValid: () => valid,
    close: vi.fn(),
    invalidate: () => {
      valid = false
      invalidated()
    }
  }
}

const routes: LocalSshBrowserRoute[] = []

afterEach(async () => {
  await Promise.all(routes.splice(0).map((route) => route.close()))
  await closeAllLocalSshBrowserRoutes()
})

async function socksConnect(port: number, host: string, targetPort: number): Promise<Socket> {
  const socket = connect(port, '127.0.0.1')
  await once(socket, 'connect')
  socket.write(new Uint8Array([5, 1, 0]))
  await readExact(socket, 2)
  const hostBytes = new TextEncoder().encode(host)
  socket.write(
    new Uint8Array([
      5,
      1,
      0,
      3,
      hostBytes.byteLength,
      ...hostBytes,
      (targetPort >>> 8) & 0xff,
      targetPort & 0xff
    ])
  )
  return socket
}

async function readExact(socket: Socket, size: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  while (total < size) {
    const [chunk] = (await once(socket, 'data')) as [Buffer]
    chunks.push(chunk)
    total += chunk.byteLength
  }
  const combined = Buffer.concat(chunks)
  if (combined.byteLength > size) {
    socket.unshift(combined.subarray(size))
  }
  return combined.subarray(0, size)
}

describe('LocalSshBrowserRoute', () => {
  it('dials the exact hostname through the execution route and round-trips bytes', async () => {
    const executionRoute = fakeExecutionRoute('route-1')
    const route = new LocalSshBrowserRoute('target-a', {
      resolveExecutionRoute: async () => executionRoute,
      getAuthority: () => ({ providerEpoch: 'epoch-1', connectionGeneration: 1 })
    })
    routes.push(route)
    const address = await route.listen()

    const socket = await socksConnect(address.port, 'internal.only.host', 8443)
    const reply = await readExact(socket, 10)
    expect(reply[1]).toBe(0)
    // Why: the hostname must reach the SSH dial verbatim — remote DNS is the contract.
    expect(executionRoute.dials).toEqual([{ host: 'internal.only.host', port: 8443 }])

    socket.write(Buffer.from('ping'))
    const echoed = await readExact(socket, 4)
    expect(echoed.toString()).toBe('ping')
    socket.destroy()
  })

  it('keeps the listener port stable and re-resolves under the fresh authority after rotation', async () => {
    const resolved: BrowserNetworkExecutionRouteContext[] = []
    const executionRoutes: FakeRoute[] = []
    let generation = 1
    const route = new LocalSshBrowserRoute('target-a', {
      resolveExecutionRoute: async (context) => {
        resolved.push(context)
        const fresh = fakeExecutionRoute(`route-${resolved.length}`)
        executionRoutes.push(fresh)
        return fresh
      },
      getAuthority: () => ({
        providerEpoch: `epoch-${generation}`,
        connectionGeneration: generation
      })
    })
    routes.push(route)
    const address = await route.listen()

    const first = await socksConnect(address.port, 'host-one', 80)
    expect((await readExact(first, 10))[1]).toBe(0)
    first.destroy()

    // A real SSH drop: the authority rotates and the old route is aborted.
    generation = 2
    executionRoutes[0].invalidate()
    await new Promise((resolve) => setImmediate(resolve))

    const second = await socksConnect(address.port, 'host-two', 81)
    expect((await readExact(second, 10))[1]).toBe(0)
    second.destroy()

    expect(await route.listen()).toEqual(address)
    expect(resolved).toHaveLength(2)
    const secondHost = resolved[1].executionHost
    expect(secondHost.kind).toBe('ssh')
    if (secondHost.kind === 'ssh') {
      expect(secondHost.connectionGeneration).toBe(2)
      expect(secondHost.providerEpoch).toBe('epoch-2')
    }
    expect(executionRoutes[0].close).toHaveBeenCalled()
  })

  it('fails the SOCKS request while the target is unavailable and recovers on the next dial', async () => {
    let available = false
    const route = new LocalSshBrowserRoute('target-a', {
      resolveExecutionRoute: async () => {
        if (!available) {
          throw new Error('browser_tunnel_execution_host_unavailable')
        }
        return fakeExecutionRoute('route-live')
      },
      getAuthority: () => ({ providerEpoch: 'epoch-1', connectionGeneration: 1 })
    })
    routes.push(route)
    const address = await route.listen()

    const refused = await socksConnect(address.port, 'example.test', 443)
    const failure = await readExact(refused, 2)
    // Why: fail closed — never a direct local dial when the SSH path is down.
    expect(failure[1]).not.toBe(0)
    refused.destroy()

    available = true
    const accepted = await socksConnect(address.port, 'example.test', 443)
    expect((await readExact(accepted, 10))[1]).toBe(0)
    accepted.destroy()
  })

  it('retains one shared route per target', async () => {
    const dependencies = {
      resolveExecutionRoute: async () => fakeExecutionRoute('route-shared'),
      getAuthority: () => ({ providerEpoch: 'epoch-1', connectionGeneration: 1 })
    }
    const first = await retainLocalSshBrowserRoute('target-shared', dependencies)
    const second = await retainLocalSshBrowserRoute('target-shared', dependencies)
    expect(second.port).toBe(first.port)
  })

  it('drops the shared route on explicit close so a re-add starts fresh', async () => {
    const dependencies = {
      resolveExecutionRoute: async () => fakeExecutionRoute('route-shared'),
      getAuthority: () => ({ providerEpoch: 'epoch-1', connectionGeneration: 1 })
    }
    const first = await retainLocalSshBrowserRoute('target-cycled', dependencies)
    await closeLocalSshBrowserRouteForTarget('target-cycled')
    const second = await retainLocalSshBrowserRoute('target-cycled', dependencies)
    // Why: the closed listener is unusable; a fresh retain must produce a live one.
    const socket = await socksConnect(second.port, 'after-readd', 80)
    expect((await readExact(socket, 10))[1]).toBe(0)
    socket.destroy()
    expect(first.port).not.toBe(0)
  })

  it('classifies forwarding probes by the wire reason code, never by scary wording', async () => {
    let failure: (Error & { reason?: number }) | null = null
    const route = new LocalSshBrowserRoute('target-probe', {
      resolveExecutionRoute: async () => {
        const executionRoute = fakeExecutionRoute('route-probe')
        const originalConnect = executionRoute.connect
        executionRoute.connect = (target) => {
          if (failure) {
            const socket = new FakeTunnelSocket('never-connect')
            const error = failure
            queueMicrotask(() => {
              socket.emit('error', error)
            })
            return socket
          }
          return originalConnect(target)
        }
        return executionRoute
      },
      getAuthority: () => ({ providerEpoch: 'epoch-1', connectionGeneration: 1 })
    })
    routes.push(route)
    await route.listen()

    const withReason = (message: string, reason?: number): Error & { reason?: number } => {
      const error = new Error(message) as Error & { reason?: number }
      if (reason !== undefined) {
        error.reason = reason
      }
      return error
    }

    // RFC 4254 reason 1 = ADMINISTRATIVELY_PROHIBITED, regardless of wording.
    failure = withReason('(SSH) Channel open failure: open failed', 1)
    expect(await route.probeForwarding(500)).toBe('forwarding-blocked')
    // Why (false-positive pin): CONNECT_FAILED with hostile wording must read
    // as ok — a firewall's "denied" text proves the CHANNEL was allowed.
    failure = withReason('(SSH) Channel open failure: connection denied by firewall', 2)
    expect(await route.probeForwarding(500)).toBe('ok')
    // No wire code: only the canonical OpenSSH phrase classifies as blocked.
    failure = withReason('administratively prohibited: open failed')
    expect(await route.probeForwarding(500)).toBe('forwarding-blocked')
    failure = withReason('open forbidden: access denied, not allowed')
    expect(await route.probeForwarding(500)).toBe('ok')
    failure = null
    expect(await route.probeForwarding(500)).toBe('ok')
  })

  it('reports ssh-unavailable when the probe cannot resolve a route', async () => {
    const route = new LocalSshBrowserRoute('target-down', {
      resolveExecutionRoute: async () => {
        throw new Error('browser_tunnel_execution_host_unavailable')
      },
      getAuthority: () => ({ providerEpoch: 'epoch-1', connectionGeneration: 1 })
    })
    routes.push(route)
    expect(await route.probeForwarding(500)).toBe('ssh-unavailable')
  })
})
