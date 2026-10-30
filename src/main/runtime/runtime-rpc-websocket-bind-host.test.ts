import './rpc/unused-default-rpc-methods.test-fixture'
import { mkdtempSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { WebSocketTransport } from './rpc/ws-transport'
import { DeviceRegistry } from './device-registry'
import { DEVICE_REGISTRY_FILENAME } from './mobile-pairing-files'

vi.mock('../git/worktree', () => {
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
})

describe('OrcaRuntimeRpcServer WebSocket bind host (STA-2370)', () => {
  const wsTransportOf = (server: OrcaRuntimeRpcServer): WebSocketTransport | undefined =>
    (server['activeTransports'] as unknown[]).find(
      (transport): transport is WebSocketTransport => transport instanceof WebSocketTransport
    )

  it('binds the listener to loopback on a fresh desktop with no paired device', async () => {
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
      expect(server.getDeviceRegistry()?.listDevices()).toHaveLength(0)
      // Before STA-2370, an unpaired desktop exposed all interfaces.
      expect(wsTransportOf(server)?.resolvedHost).toBe('127.0.0.1')
      expect(new URL(server.getWebSocketEndpoint()!).hostname).toBe('127.0.0.1')
    } finally {
      await server.stop()
    }
  })

  it('widens the listener to all interfaces when a mobile pairing offer is created', async () => {
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
      const loopbackPort = wsTransportOf(server)?.resolvedPort
      expect(wsTransportOf(server)?.resolvedHost).toBe('127.0.0.1')

      const offer = await server.createMobilePairingOffer({
        address: '100.64.1.20',
        connectionMode: 'local-only'
      })
      expect(offer.available).toBe(true)

      expect(wsTransportOf(server)?.resolvedHost).toBe('0.0.0.0')
      expect(new URL(server.getWebSocketEndpoint()!).hostname).toBe('0.0.0.0')
      // Reuse the advertised port so existing QR endpoints remain valid.
      expect(wsTransportOf(server)?.resolvedPort).toBe(loopbackPort)
    } finally {
      await server.stop()
    }
  })

  it('binds all interfaces at startup when exposeNetworkByDefault is set (orca serve)', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
      methods: [],
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0,
      exposeNetworkByDefault: true
    })

    await server.start()
    try {
      expect(wsTransportOf(server)?.resolvedHost).toBe('0.0.0.0')
      expect(new URL(server.getWebSocketEndpoint()!).hostname).toBe('0.0.0.0')
    } finally {
      await server.stop()
    }
  })

  it('binds all interfaces at startup when a previously-connected device can reconnect', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    // Previously connected devices may reconnect without another pairing action.
    const registry = new DeviceRegistry(userDataPath)
    const device = registry.getOrCreatePendingDevice('Paired phone', 'mobile')
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
      expect(
        server
          .getDeviceRegistry()
          ?.listDevices()
          .some((d) => d.lastSeenAt > 0)
      ).toBe(true)
      expect(wsTransportOf(server)?.resolvedHost).toBe('0.0.0.0')
    } finally {
      await server.stop()
    }
  })

  it('stays on loopback at startup for a pending device that has never connected', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    // Unscanned pending offers are not reconnects and must leave the listener loopback.
    const registry = new DeviceRegistry(userDataPath)
    registry.getOrCreatePendingDevice('Pending phone', 'mobile')

    const server = new OrcaRuntimeRpcServer({
      methods: [],
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })

    await server.start()
    try {
      expect(server.getDeviceRegistry()?.listDevices()).toHaveLength(1)
      expect(
        server
          .getDeviceRegistry()
          ?.listDevices()
          .every((d) => d.lastSeenAt === 0)
      ).toBe(true)
      expect(wsTransportOf(server)?.resolvedHost).toBe('127.0.0.1')
    } finally {
      await server.stop()
    }
  })

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

  it('binds all interfaces at startup for a connected device paired before pairingReach existed', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    // Older grants imply network reach; retain reconnect exposure when the field is absent.
    const legacyDevice = {
      deviceId: 'legacy-device',
      name: 'Legacy phone',
      token: 'legacy-token',
      scope: 'mobile',
      pairedAt: Date.now(),
      lastSeenAt: Date.now()
    }
    await writeFile(
      join(userDataPath, DEVICE_REGISTRY_FILENAME),
      JSON.stringify([legacyDevice]),
      'utf-8'
    )

    const server = new OrcaRuntimeRpcServer({
      methods: [],
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })

    await server.start()
    try {
      expect(wsTransportOf(server)?.resolvedHost).toBe('0.0.0.0')
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

  it('keeps the same MobileSocketWiring instance across a pairing widen (relay capture stays valid)', async () => {
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
      const wiringBeforeWiden = server.getMobileSocketWiring()
      expect(wiringBeforeWiden).not.toBeNull()
      expect(wsTransportOf(server)?.resolvedHost).toBe('127.0.0.1')

      const offer = await server.createMobilePairingOffer({
        address: '100.64.1.20',
        connectionMode: 'local-only'
      })
      expect(offer.available).toBe(true)
      expect(wsTransportOf(server)?.resolvedHost).toBe('0.0.0.0')

      // Relay brokers retain session wiring identity; replace its transport, not its connection/binary/revocation state.
      expect(server.getMobileSocketWiring()).toBe(wiringBeforeWiden)

      // Prove the wiring swap functionally: pre-widen wiring must revoke through the new wide transport, not merely retain object identity.
      const widenedTransport = wsTransportOf(server)
      expect(widenedTransport).toBeDefined()
      const terminateSpy = vi.spyOn(widenedTransport!, 'terminateClientConnections')
      wiringBeforeWiden!.terminateDeviceConnections('device-token-xyz')
      expect(terminateSpy).toHaveBeenCalledWith('device-token-xyz')
    } finally {
      await server.stop()
    }
  })

  it('coalesces concurrent pairing widens into a single rebind', async () => {
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
      expect(wsTransportOf(server)?.resolvedHost).toBe('127.0.0.1')
      const widenSpy = vi.spyOn(
        server as unknown as { widenWebSocketBind: () => Promise<void> },
        'widenWebSocketBind'
      )

      await Promise.all([server.ensureNetworkExposure(), server.ensureNetworkExposure()])

      // Coalesce concurrent offers into one networkExposurePromise or stop/start races can strand the listener on another port.
      expect(widenSpy).toHaveBeenCalledTimes(1)
      expect(wsTransportOf(server)?.resolvedHost).toBe('0.0.0.0')
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

  it('honours a pinned bind host over exposeNetworkByDefault (orcad --bind)', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
      methods: [],
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0,
      // Explicit unattended-host bind policy must beat every implicit widening path.
      exposeNetworkByDefault: true,
      pinnedBindHost: '127.0.0.1'
    })

    await server.start()
    try {
      expect(wsTransportOf(server)?.resolvedHost).toBe('127.0.0.1')
      expect(new URL(server.getWebSocketEndpoint()!).hostname).toBe('127.0.0.1')
    } finally {
      await server.stop()
    }
  })

  it('stays pinned to loopback even after a device has connected once', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    // A loopback pin must survive first network pairing and restart; reconnect defaults cannot widen it silently.
    const registry = new DeviceRegistry(userDataPath)
    const device = registry.getOrCreatePendingDevice('CLI', 'runtime', 'network')
    registry.updateLastSeen(device.deviceId)

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
      expect(
        server
          .getDeviceRegistry()
          ?.listDevices()
          .some((d) => d.lastSeenAt > 0)
      ).toBe(true)
      expect(wsTransportOf(server)?.resolvedHost).toBe('127.0.0.1')
    } finally {
      await server.stop()
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

  it('still widens on request when the operator pinned the wide address', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
      methods: [],
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0,
      pinnedBindHost: '0.0.0.0'
    })

    await server.start()
    try {
      expect(wsTransportOf(server)?.resolvedHost).toBe('0.0.0.0')
      await server.ensureNetworkExposure()
      expect(wsTransportOf(server)?.resolvedHost).toBe('0.0.0.0')
    } finally {
      await server.stop()
    }
  })

  it('refuses to widen a pairing offer that arrives after the server has stopped', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
      methods: [],
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })

    await server.start()
    const widenSpy = vi.spyOn(
      server as unknown as { widenWebSocketBind: () => Promise<void> },
      'widenWebSocketBind'
    )
    await server.stop()

    // After shutdown, refuse fresh exposure requests too; racing-widen tests alone miss reopening a stopped listener.
    await server.ensureNetworkExposure()
    expect(widenSpy).not.toHaveBeenCalled()
  })
})
