import type * as WorktreeScanCacheModule from '../../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../../git/worktrees/catalog/worktree-listing'
import '../unused-default-rpc-methods.test-fixture'
import { mkdtempSync } from 'node:fs'
import 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { WebSocketTransport } from '../ws-transport'
import { DeviceRegistry } from './pairing/device-registry'
import './pairing/mobile-pairing-files'

vi.mock('../../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  const listings = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktrees: listings.listWorktrees
  }
})

vi.mock('../../../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
  const listings = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeListingModule>()),
    listWorktreesStrict: listings.listWorktreesStrict
  }
})

const { getWorktreeListingMocks } = vi.hoisted(() => {
  function createWorktreeListingMocks() {
    const worktrees = [
      {
        path: '/tmp/worktree-a',
        head: 'abc',
        branch: 'feature/foo',
        isBare: false,
        isMainWorktree: false
      }
    ]
    return {
      listWorktrees: vi.fn().mockResolvedValue(worktrees),
      listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
    }
  }
  let listings: ReturnType<typeof createWorktreeListingMocks> | undefined
  return { getWorktreeListingMocks: () => (listings ??= createWorktreeListingMocks()) }
})

describe('OrcaRuntimeRpcServer WebSocket bind host (STA-2370)', () => {
  const wsTransportOf = (server: OrcaRuntimeRpcServer): WebSocketTransport | undefined =>
    (server['activeTransports'] as unknown[]).find(
      (transport): transport is WebSocketTransport => transport instanceof WebSocketTransport
    )

  it('stays on loopback at startup after a "This computer only" grant has connected', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    // Local-only browser grants also get lastSeenAt; counting them would expose every interface on next launch against the chosen policy.
    const registry = new DeviceRegistry(userDataPath)
    const device = registry.getOrCreatePendingDevice('Runtime local', 'runtime', 'this-computer')
    registry.updateLastSeen(device.deviceId)

    const server = new OrcaRuntimeRpcServer({
      methods: [],
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })

    await server.start()
    try {
      expect(wsTransportOf(server)?.resolvedHost).toBe('127.0.0.1')
    } finally {
      await server.stop()
    }
  })

  it('upgrades a reused pending grant to network reach so its link survives a relaunch', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
      methods: [],
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })

    await server.start()
    let deviceId: string
    try {
      const local = server.createPairingOffer({
        address: '127.0.0.1',
        scope: 'runtime',
        reach: 'this-computer'
      })
      expect(local.available).toBe(true)
      // Re-advertised pending tokens gaining network reach need that policy persisted or restart leaves LAN unserved.
      const network = server.createPairingOffer({
        address: '100.64.1.20',
        scope: 'runtime',
        reach: 'network'
      })
      expect(network.available).toBe(true)
      deviceId = network.available ? network.deviceId : ''
      expect(deviceId).toBe(local.available ? local.deviceId : '')
      server.getDeviceRegistry()?.updateLastSeen(deviceId)
    } finally {
      await server.stop()
    }

    const relaunched = new OrcaRuntimeRpcServer({
      methods: [],
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    await relaunched.start()
    try {
      expect(wsTransportOf(relaunched)?.resolvedHost).toBe('0.0.0.0')
    } finally {
      await relaunched.stop()
    }
  })

  it('keeps the pinned port when a later widen tears down a live loopback client', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
      methods: [],
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })

    await server.start()
    try {
      const loopbackPort = wsTransportOf(server)!.resolvedPort
      // Local-only clients can precede LAN opt-in; rebind disconnects them, so reuse the port for their existing links.
      const client = new WebSocket(`ws://127.0.0.1:${loopbackPort}`)
      await new Promise<void>((resolve, reject) => {
        client.once('open', () => resolve())
        client.once('error', reject)
      })
      const closed = new Promise<void>((resolve) => client.once('close', () => resolve()))

      await server.ensureNetworkExposure()
      await closed

      expect(wsTransportOf(server)?.resolvedHost).toBe('0.0.0.0')
      expect(wsTransportOf(server)?.resolvedPort).toBe(loopbackPort)

      const reconnected = new WebSocket(`ws://127.0.0.1:${loopbackPort}`)
      await new Promise<void>((resolve, reject) => {
        reconnected.once('open', () => resolve())
        reconnected.once('error', reject)
      })
      reconnected.close()
    } finally {
      await server.stop()
    }
  })

  it('reports pairing unavailable but keeps a serving loopback listener when the widen bind fails', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const server = new OrcaRuntimeRpcServer({
      methods: [],
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })

    await server.start()
    try {
      const loopbackPort = wsTransportOf(server)?.resolvedPort
      // Fail wide bind after loopback stops, then allow same-port loopback recovery so serving and retry survive.
      const target = server as unknown as {
        startWebSocketTransport: (opts: { host: string }) => Promise<unknown>
        wsBoundHost: string | null
      }
      const original = target.startWebSocketTransport.bind(server)
      vi.spyOn(target, 'startWebSocketTransport').mockImplementation(async (opts) => {
        if (opts.host === '0.0.0.0') {
          throw new Error('injected wide bind failure')
        }
        return original(opts)
      })

      const offer = await server.createMobilePairingOffer({
        address: '100.64.1.20',
        connectionMode: 'local-only'
      })
      // Failed exposure must return unavailable rather than advertise an unserved LAN endpoint (STA-2370).
      expect(offer.available).toBe(false)
      if (!offer.available) {
        expect(offer.reason).toBe('network_exposure_failed')
      }
      // Recovery must keep loopback serving at the original port.
      expect(wsTransportOf(server)?.resolvedHost).toBe('127.0.0.1')
      expect(wsTransportOf(server)?.resolvedPort).toBe(loopbackPort)
      // Retain loopback bound-host state so the next offer retries.
      expect(target.wsBoundHost).toBe('127.0.0.1')
    } finally {
      await server.stop()
      errorSpy.mockRestore()
    }
  })

  it('keeps the widened listener tracked when persisting pairing metadata fails', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const server = new OrcaRuntimeRpcServer({
      methods: [],
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })

    await server.start()
    try {
      // Fail metadata persistence after successful wide bind; keep that listener tracked for shutdown, never orphaned by loopback recovery.
      const target = server as unknown as {
        writeMetadata: () => void
        wsBoundHost: string | null
        activeTransports: unknown[]
      }
      let injected = false
      const originalWrite = target.writeMetadata.bind(server)
      vi.spyOn(target, 'writeMetadata').mockImplementation(() => {
        if (!injected && target.wsBoundHost === '0.0.0.0') {
          injected = true
          throw new Error('injected metadata write failure')
        }
        return originalWrite()
      })

      const offer = await server.createMobilePairingOffer({
        address: '100.64.1.20',
        connectionMode: 'local-only'
      })
      expect(injected).toBe(true)
      // Wide listener already succeeded; metadata failure must preserve available pairing and exactly one tracked transport.
      expect(offer.available).toBe(true)
      expect(wsTransportOf(server)?.resolvedHost).toBe('0.0.0.0')
      expect(target.activeTransports.filter((t) => t instanceof WebSocketTransport)).toHaveLength(1)
    } finally {
      await server.stop()
      errorSpy.mockRestore()
    }
  })

  it('does not strand a wide listener when stop() races an in-flight widen', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const server = new OrcaRuntimeRpcServer({
      methods: [],
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })

    await server.start()

    const target = server as unknown as {
      startWebSocketTransport: (opts: {
        host: string
      }) => Promise<{ transport: WebSocketTransport; endpoint: string }>
      activeTransports: unknown[]
    }
    const original = target.startWebSocketTransport.bind(server)
    let releaseWideStart: () => void = () => {}
    const wideStartGate = new Promise<void>((resolve) => {
      releaseWideStart = resolve
    })
    let wideStopSpy: ReturnType<typeof vi.spyOn> = null
    vi.spyOn(target, 'startWebSocketTransport').mockImplementation(async (opts) => {
      if (opts.host === '0.0.0.0') {
        // Hold rebind after loopback stop to race shutdown against pending exposure.
        await wideStartGate
        const result = await original(opts)
        wideStopSpy = vi.spyOn(result.transport, 'stop')
        return result
      }
      return original(opts)
    })

    // Start shutdown while exposure is still in flight.
    const widen = server.ensureNetworkExposure()
    const stopping = server.stop()
    releaseWideStart()
    await Promise.all([widen.catch(() => {}), stopping])

    try {
      // Shutdown must await/fence exposure before snapshotting transports or a late wide bind leaks past stop (STA-2370).
      expect(target.activeTransports).toHaveLength(0)
      expect(wideStopSpy).not.toBeNull()
      expect(wideStopSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('refuses a runtime-widening pairing offer while the bind is pinned to loopback', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const server = new OrcaRuntimeRpcServer({
      methods: [],
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0,
      pinnedBindHost: '127.0.0.1'
    })

    await server.start()
    try {
      // Remote pairing RPCs must not override the operator's bind pin.
      const offer = await server.createMobilePairingOffer({
        address: '100.64.1.20',
        connectionMode: 'local-only'
      })
      expect(offer.available).toBe(false)
      if (!offer.available) {
        expect(offer.reason).toBe('network_exposure_failed')
      }
      expect(wsTransportOf(server)?.resolvedHost).toBe('127.0.0.1')
    } finally {
      await server.stop()
      errorSpy.mockRestore()
    }
  })
})
