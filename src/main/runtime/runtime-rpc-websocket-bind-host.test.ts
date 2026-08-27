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
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })

    await server.start()
    try {
      expect(server.getDeviceRegistry()?.listDevices()).toHaveLength(0)
      // Why: the exposure regression — before STA-2370 this bound 0.0.0.0 with zero devices paired.
      expect(wsTransportOf(server)?.resolvedHost).toBe('127.0.0.1')
      expect(new URL(server.getWebSocketEndpoint()!).hostname).toBe('127.0.0.1')
    } finally {
      await server.stop()
    }
  })

  it('widens the listener to all interfaces when a mobile pairing offer is created', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
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
      // Why: the widen reuses the same port so the QR's already-advertised endpoint stays valid.
      expect(wsTransportOf(server)?.resolvedPort).toBe(loopbackPort)
    } finally {
      await server.stop()
    }
  })

  it('binds all interfaces at startup when exposeNetworkByDefault is set (orca serve)', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
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
    // Why: a device that has actually connected (lastSeenAt > 0) may reconnect, so the listener must be
    // reachable at startup without waiting for a new pairing action.
    const registry = new DeviceRegistry(userDataPath)
    const device = registry.getOrCreatePendingDevice('Paired phone', 'mobile')
    registry.updateLastSeen(device.deviceId)

    const server = new OrcaRuntimeRpcServer({
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
    // Why: a pending device (offer created but never connected: lastSeenAt === 0) is not a reconnect, so
    // the listener must stay loopback — this distinguishes the reconnect widen from a blanket any-device
    // widen (a revert to listDevices().length > 0 would wrongly expose the LAN here).
    const registry = new DeviceRegistry(userDataPath)
    registry.getOrCreatePendingDevice('Pending phone', 'mobile')

    const server = new OrcaRuntimeRpcServer({
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
    // Why: the local web client authenticating marks its grant lastSeenAt > 0 like any other socket, so a
    // blanket "any connected device" widen republished the runtime on every interface one launch later —
    // exactly what the user declined by picking "This computer only".
    const registry = new DeviceRegistry(userDataPath)
    const device = registry.getOrCreatePendingDevice('Runtime local', 'runtime', 'this-computer')
    registry.updateLastSeen(device.deviceId)

    const server = new OrcaRuntimeRpcServer({
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
    // Why: registries written by older desktops only ever held network-reach grants; a missing field must
    // keep the reconnect widen or an already-paired phone would be stranded by the upgrade.
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
      // Why: without `rotate` the same pending token is re-advertised, now for off-host reach. The mark must
      // widen with it — keeping it this-computer would leave the LAN link unserved after the next launch.
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
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })

    await server.start()
    try {
      const loopbackPort = wsTransportOf(server)!.resolvedPort
      // Why: a "This computer only" link never widens, so unlike before, a local client can already be
      // connected when a later LAN offer opts in. The rebind terminates it (ws cannot move a listener), so
      // the port must be reused or the already-issued local link could never reconnect.
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

      // Why: DesktopRelayService captures the wiring once at construction and hands it to every relay
      // broker, so the widen must swap the transport under the SAME wiring — replacing the wiring would
      // strand relay sockets on a dead object (lost connection IDs, binary handling, revocation targeting).
      expect(server.getMobileSocketWiring()).toBe(wiringBeforeWiden)

      // Why: object identity alone would pass even if the post-widen transport were never re-attached to the
      // captured wiring. Prove the swap functionally — route a revocation through the pre-widen wiring and
      // assert it reaches the NEW (0.0.0.0) transport, confirming attachTransport ran on the same wiring
      // after the rebind. A revert that leaves the wiring pointed at the stopped loopback transport fails here.
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

      // Why: two racing pairing offers must share one rebind via networkExposurePromise — two competing
      // stop/start races would fight for the port and could strand the listener on a random one.
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
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })

    await server.start()
    try {
      const loopbackPort = wsTransportOf(server)?.resolvedPort
      // Why: force the wide bind to throw AFTER the loopback listener is stopped, then let the loopback
      // recovery bind through — proving no stranded/closed socket and a retry-able state.
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
      // Why: a failed widen must NOT advertise a LAN endpoint with no LAN listener behind it — the offer is
      // reported unavailable (STA-2370). A revert that swallows the widen failure would return available:true.
      expect(offer.available).toBe(false)
      if (!offer.available) {
        expect(offer.reason).toBe('network_exposure_failed')
      }
      // Why: the listener must keep serving on loopback (same port) rather than being left stranded/closed.
      expect(wsTransportOf(server)?.resolvedHost).toBe('127.0.0.1')
      expect(wsTransportOf(server)?.resolvedPort).toBe(loopbackPort)
      // Why: wsBoundHost stays loopback so a later pairing offer retries the widen.
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
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })

    await server.start()
    try {
      // Why: fail metadata publication AFTER the wide bind already succeeded. The live 0.0.0.0 listener must
      // stay tracked in activeTransports — a revert that runs loopback recovery here orphans a running wide
      // listener (an untracked 0.0.0.0 socket outside stop(): the exact STA-2370 exposure).
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
      // Why: only metadata persistence failed; the wide bind succeeded, so pairing is available and the wide
      // listener is tracked (not orphaned) — bound to all interfaces, exactly one WebSocket transport.
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
        // Why: hold the widen mid-flight (loopback already stopped) so stop() must race the rebind.
        await wideStartGate
        const result = await original(opts)
        wideStopSpy = vi.spyOn(result.transport, 'stop')
        return result
      }
      return original(opts)
    })

    // Why: begin a pairing widen but do not await it, then start shutdown while it is still in-flight.
    const widen = server.ensureNetworkExposure()
    const stopping = server.stop()
    releaseWideStart()
    await Promise.all([widen.catch(() => {}), stopping])

    try {
      // Why: STA-2370 — stop() must fence and await the in-flight widen so the freshly-bound wide listener is
      // snapshotted and stopped, never written back into the cleared arrays as a live 0.0.0.0 leak. A revert
      // (no fence) leaves the wide transport in activeTransports after stop() and never calls its stop().
      expect(target.activeTransports).toHaveLength(0)
      expect(wideStopSpy).not.toBeNull()
      expect(wideStopSpy).toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('refuses to widen a pairing offer that arrives after the server has stopped', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-runtime-rpc-'))
    const server = new OrcaRuntimeRpcServer({
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

    // Why: STA-2370 — the `stopping` fence must reject a widen that arrives on its own AFTER shutdown, not
    // only one already in-flight during stop() (covered above via the pending-exposure await). Reverting the
    // `stopping` guard alone still passes the race test, but here ensureNetworkExposure would re-enter
    // widenWebSocketBind and re-open a 0.0.0.0 listener on a server that is supposed to be down.
    await server.ensureNetworkExposure()
    expect(widenSpy).not.toHaveBeenCalled()
  })
})
