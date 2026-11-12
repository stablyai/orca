import type { LookupAddress } from 'node:dns'
import { createServer, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserNetworkDeferredSocket } from '../execution-routes/browser-network-deferred-socket'
import {
  connectNativeBrowserNetworkTarget,
  guardRemoteBrowserNetworkConnect
} from '../execution-routes/browser-network-execution-route'
import {
  BrowserTunnelDestinationBlockedError,
  browserTunnelTargetBlockReason,
  createBrowserTunnelGuardedLookup,
  reserveBrowserTunnelOrcaListenerPort
} from './browser-network-tunnel-destination-policy'
import type { BrowserNetworkTunnelSocket } from './browser-network-tunnel-stream-state'

const cleanups: (() => void | Promise<void>)[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup()
  }
})

describe('browser tunnel destination policy', () => {
  it.each([
    ['169.254.169.254', 80],
    ['169.254.170.2', 80],
    ['169.254.1.1', 443],
    ['::ffff:169.254.169.254', 80],
    ['::ffff:a9fe:a9fe', 80],
    ['0000:0000:0000:0000:0000:ffff:a9fe:a9fe', 80],
    ['64:ff9b::a9fe:a9fe', 80],
    ['fd00:ec2::254', 80],
    ['fe80::1', 80],
    ['100.100.100.200', 80],
    ['metadata.google.internal', 80],
    ['METADATA.google.internal.', 80],
    ['metadata.goog', 80],
    ['instance-data.ec2.internal', 80],
    ['2852039166', 80],
    ['0xa9.0xfe.0xa9fe', 80],
    ['169.254.43518', 80],
    ['0251.0376.0251.0376', 80]
  ])('blocks link-local or metadata %s:%i', (host, port) => {
    expect(browserTunnelTargetBlockReason(host, port)).toBe('link_local')
  })

  it("blocks only the host's own reserved Orca listener ports, and only while reserved", () => {
    const release = reserveBrowserTunnelOrcaListenerPort(6768)
    cleanups.push(release)

    for (const host of ['localhost', 'app.localhost', '127.0.0.1', '127.1.2.3', '::1', '0.0.0.0']) {
      expect(browserTunnelTargetBlockReason(host, 6768)).toBe('orca_listener')
    }
    expect(browserTunnelTargetBlockReason('127.0.0.1', 6769)).toBeNull()
    expect(browserTunnelTargetBlockReason('203.0.113.9', 6768)).toBeNull()

    release()
    expect(browserTunnelTargetBlockReason('127.0.0.1', 6768)).toBeNull()
  })

  it('drops blocked DNS answers so a rebinding name cannot reach metadata', async () => {
    const answers: LookupAddress[] = [
      { address: '169.254.169.254', family: 4 },
      { address: '93.184.216.34', family: 4 }
    ]
    const onBlocked = vi.fn()
    const lookup = createBrowserTunnelGuardedLookup(80, onBlocked, (_host, _options, callback) =>
      callback(null, answers)
    )

    const mixed = await new Promise<unknown>((resolve) =>
      lookup('rebind.test', { all: true }, (_error, addresses) => resolve(addresses))
    )
    expect(mixed).toEqual([{ address: '93.184.216.34', family: 4 }])

    answers.splice(1)
    const blocked = await new Promise<unknown>((resolve) =>
      lookup('rebind.test', { all: true }, (error) => resolve(error))
    )
    expect(blocked).toBeInstanceOf(BrowserTunnelDestinationBlockedError)
    expect(onBlocked).toHaveBeenCalledWith('link_local')

    answers.splice(0)
    const missing = await new Promise<unknown>((resolve) =>
      lookup('missing.test', { all: true }, (error) => resolve(error))
    )
    expect(missing).not.toBeInstanceOf(BrowserTunnelDestinationBlockedError)
    expect(missing).toMatchObject({ code: 'ENOTFOUND' })
  })
})

describe('remote (SSH/WSL) browser tunnel routes', () => {
  it("refuse the remote machine's metadata but keep its loopback and Orca-port-numbered servers", () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    cleanups.push(reserveBrowserTunnelOrcaListenerPort(6768))
    const dialed: string[] = []
    const connect = guardRemoteBrowserNetworkConnect((target) => {
      dialed.push(`${target.host}:${target.port}`)
      return new BrowserNetworkDeferredSocket()
    }, {})

    expect(() => connect({ host: '169.254.169.254', port: 80 })).toThrow(
      BrowserTunnelDestinationBlockedError
    )
    for (const host of [
      'metadata.google.internal',
      'instance-data',
      '2852039166',
      '0xa9.0xfe.0xa9fe'
    ]) {
      expect(() => connect({ host, port: 80 })).toThrow(BrowserTunnelDestinationBlockedError)
    }
    connect({ host: '2130706433', port: 3000 })
    connect({ host: '127.0.0.1', port: 6768 })
    connect({ host: 'localhost', port: 3000 })
    expect(dialed).toEqual(['2130706433:3000', '127.0.0.1:6768', 'localhost:3000'])
  })
})

describe('native browser tunnel dial', () => {
  async function startServer(): Promise<number> {
    const sockets = new Set<Socket>()
    const server = createServer((socket) => {
      sockets.add(socket)
      socket.end('ok')
    })
    const port = await new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    )
    cleanups.push(
      () =>
        new Promise<void>((done) => {
          sockets.forEach((socket) => socket.destroy())
          server.close(() => done())
        })
    )
    return port
  }

  function outcome(socket: BrowserNetworkTunnelSocket): Promise<unknown> {
    return new Promise((resolve) => {
      socket.on('connect', () => {
        socket.destroy()
        resolve('connected')
      })
      socket.on('error', (error) => resolve(error))
    })
  }

  it('still reaches a dev server on host loopback by name and by address', async () => {
    const port = await startServer()
    await expect(
      outcome(connectNativeBrowserNetworkTarget({ host: '127.0.0.1', port }, {}))
    ).resolves.toBe('connected')
    await expect(
      outcome(connectNativeBrowserNetworkTarget({ host: 'localhost', port }, {}))
    ).resolves.toBe('connected')
  })

  it('restores unrestricted dialing when the host opts out', async () => {
    const port = await startServer()
    cleanups.push(reserveBrowserTunnelOrcaListenerPort(port))

    await expect(
      outcome(
        connectNativeBrowserNetworkTarget(
          { host: '127.0.0.1', port },
          { ORCA_BROWSER_TUNNEL_ALLOW_ALL_DESTINATIONS: '1' }
        )
      )
    ).resolves.toBe('connected')
  })
})
