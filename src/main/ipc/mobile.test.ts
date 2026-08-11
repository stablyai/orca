import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type * as NodeOs from 'node:os'

const { defaultRouteInterfaceNamesMock, handleMock, networkInterfacesMock } = vi.hoisted(() => ({
  defaultRouteInterfaceNamesMock: vi.fn(),
  handleMock: vi.fn(),
  networkInterfacesMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { isPackaged: false },
  ipcMain: { handle: handleMock },
  shell: { openExternal: vi.fn() }
}))

vi.mock('qrcode', () => ({
  default: {
    toDataURL: vi.fn().mockResolvedValue('data:image/png;base64,qr')
  }
}))

// Why: only the interface enumeration is faked; the real `os` stays available for the integration
// test below, which needs tmpdir() for a real runtime's user data directory.
vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  networkInterfaces: networkInterfacesMock
}))

vi.mock('../runtime/windows-default-route-interfaces', () => ({
  getWindowsDefaultRouteInterfaceNames: defaultRouteInterfaceNamesMock
}))

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerMobileHandlers } from './mobile'
import { NETWORK_EXPOSURE_FAILED_GUIDANCE } from '../runtime/network-exposure-guidance'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { WebSocketTransport } from '../runtime/rpc/ws-transport'

describe('registerMobileHandlers', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    networkInterfacesMock.mockReset()
    networkInterfacesMock.mockReturnValue({})
    defaultRouteInterfaceNamesMock.mockReset().mockResolvedValue(new Set())
    handleMock.mockImplementation((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
  })

  it('re-reads system network interfaces on each request and prefers tailnet addresses', async () => {
    networkInterfacesMock
      .mockReturnValueOnce({
        en0: [{ family: 'IPv4', internal: false, address: '192.168.1.24' }]
      })
      .mockReturnValueOnce({
        en0: [{ family: 'IPv4', internal: false, address: '192.168.1.24' }],
        tailscale0: [{ family: 'IPv4', internal: false, address: '100.64.1.20' }]
      })

    registerMobileHandlers({} as never)

    await expect(handlers.get('mobile:listNetworkInterfaces')?.()).resolves.toEqual({
      interfaces: [{ name: 'en0', address: '192.168.1.24' }]
    })
    await expect(handlers.get('mobile:listNetworkInterfaces')?.()).resolves.toEqual({
      interfaces: [
        { name: 'tailscale0', address: '100.64.1.20' },
        { name: 'en0', address: '192.168.1.24' }
      ]
    })
    expect(defaultRouteInterfaceNamesMock).not.toHaveBeenCalled()
  })

  it('excludes proxy fake-ip addresses so pairing defaults to LAN (#10404)', async () => {
    networkInterfacesMock.mockReturnValue({
      utun4: [
        { family: 'IPv4', internal: false, address: '198.18.0.1' },
        { family: 'IPv4', internal: false, address: '198.19.255.254' }
      ],
      en0: [
        { family: 'IPv4', internal: false, address: '192.168.50.238' },
        { family: 'IPv4', internal: false, address: '198.17.255.254' },
        { family: 'IPv4', internal: false, address: '198.20.0.1' }
      ]
    })
    const createMobilePairingOffer = vi.fn().mockResolvedValue({
      available: true,
      pairingUrl: 'orca://pair#lan',
      endpoint: 'ws://192.168.50.238:6768',
      deviceId: 'mobile-lan',
      connectionMode: 'automatic'
    })

    registerMobileHandlers({ createMobilePairingOffer } as never)

    await expect(handlers.get('mobile:listNetworkInterfaces')?.()).resolves.toEqual({
      interfaces: [
        { name: 'en0', address: '192.168.50.238' },
        { name: 'en0', address: '198.17.255.254' },
        { name: 'en0', address: '198.20.0.1' }
      ]
    })

    await handlers.get('mobile:getPairingQR')?.(null, {})
    expect(createMobilePairingOffer).toHaveBeenCalledWith(
      expect.objectContaining({ address: '192.168.50.238' })
    )
  })

  it('includes IPv6 addresses (ranked after IPv4) and excludes link-local IPv6', async () => {
    networkInterfacesMock.mockReturnValue({
      en0: [
        { family: 'IPv4', internal: false, address: '192.168.1.24' },
        { family: 'IPv6', internal: false, address: 'fe80::1' },
        { family: 'IPv6', internal: false, address: '2605:340:cd51:2a01:0:2b13:f279:c096' }
      ],
      lo0: [{ family: 'IPv6', internal: true, address: '::1' }]
    })

    registerMobileHandlers({} as never)

    await expect(handlers.get('mobile:listNetworkInterfaces')?.()).resolves.toEqual({
      interfaces: [
        { name: 'en0', address: '192.168.1.24' },
        { name: 'en0', address: '2605:340:cd51:2a01:0:2b13:f279:c096' }
      ]
    })
  })

  it('ranks container and VM bridges below every reachable address', async () => {
    // Why: a phone can never reach docker0, so advertising it makes the direct
    // path lose the pairing race and silently relays every session.
    networkInterfacesMock.mockReturnValue({
      docker0: [{ family: 'IPv4', internal: false, address: '172.17.0.1' }],
      'vEthernet (Default Switch)': [{ family: 'IPv4', internal: false, address: '172.28.80.1' }],
      bridge0: [{ family: 'IPv4', internal: false, address: '169.254.60.1' }],
      en0: [
        { family: 'IPv6', internal: false, address: '2605:340:cd51:2a01:0:2b13:f279:c096' },
        { family: 'IPv4', internal: false, address: '192.168.1.24' }
      ]
    })

    registerMobileHandlers({} as never)

    // Real IPv6 outranks a bridge IPv4: the phone can reach one, never the other.
    await expect(handlers.get('mobile:listNetworkInterfaces')?.()).resolves.toEqual({
      interfaces: [
        { name: 'en0', address: '192.168.1.24' },
        { name: 'en0', address: '2605:340:cd51:2a01:0:2b13:f279:c096' },
        { name: 'docker0', address: '172.17.0.1' },
        { name: 'vEthernet (Default Switch)', address: '172.28.80.1' },
        { name: 'bridge0', address: '169.254.60.1' }
      ]
    })
  })

  it('auto-advertises a route-backed Hyper-V external-switch management address', async () => {
    networkInterfacesMock.mockReturnValue({
      'vEthernet (Production LAN)': [{ family: 'IPv4', internal: false, address: '192.168.50.24' }],
      'vEthernet (Default Switch)': [{ family: 'IPv4', internal: false, address: '172.28.80.1' }],
      'vEthernet (WSL (Hyper-V firewall))': [
        { family: 'IPv4', internal: false, address: '172.20.96.1' }
      ],
      Ethernet: [{ family: 'IPv4', internal: false, address: '192.168.50.25' }]
    })
    defaultRouteInterfaceNamesMock.mockResolvedValue(
      new Set([
        'vEthernet (Production LAN)',
        'vEthernet (Default Switch)',
        'vEthernet (WSL (Hyper-V firewall))'
      ])
    )
    const createMobilePairingOffer = vi.fn().mockResolvedValue({
      available: true,
      pairingUrl: 'orca://pair#external-switch',
      endpoint: 'ws://192.168.50.24:6768',
      deviceId: 'mobile-external-switch',
      connectionMode: 'automatic'
    })

    registerMobileHandlers({ createMobilePairingOffer } as never)

    await expect(handlers.get('mobile:listNetworkInterfaces')?.()).resolves.toEqual({
      interfaces: [
        {
          name: 'vEthernet (Production LAN)',
          address: '192.168.50.24',
          hasDefaultRoute: true
        },
        { name: 'Ethernet', address: '192.168.50.25' },
        {
          name: 'vEthernet (Default Switch)',
          address: '172.28.80.1',
          hasDefaultRoute: true
        },
        {
          name: 'vEthernet (WSL (Hyper-V firewall))',
          address: '172.20.96.1',
          hasDefaultRoute: true
        }
      ]
    })
    await handlers.get('mobile:getPairingQR')?.(null, {})
    expect(createMobilePairingOffer).toHaveBeenCalledWith(
      expect.objectContaining({ address: '192.168.50.24' })
    )
  })

  it('keeps a real LAN address that merely overlaps a container subnet', async () => {
    // Why: Docker's 172.16/12 pool overlaps genuine corporate LANs, so the
    // bridge check keys on interface name — a subnet test would demote this.
    networkInterfacesMock.mockReturnValue({
      eth0: [{ family: 'IPv4', internal: false, address: '172.17.4.9' }],
      docker0: [{ family: 'IPv4', internal: false, address: '172.17.0.1' }]
    })

    registerMobileHandlers({} as never)

    await expect(handlers.get('mobile:listNetworkInterfaces')?.()).resolves.toEqual({
      interfaces: [
        { name: 'eth0', address: '172.17.4.9' },
        { name: 'docker0', address: '172.17.0.1' }
      ]
    })
  })

  it('never auto-advertises a bridge: a bridge-only host pairs over Relay with no address', async () => {
    // Why: a bridge address the phone provably cannot reach must not become the default, and Relay
    // needs no local address — so the QR ships without a direct path instead of an unreachable one.
    networkInterfacesMock.mockReturnValue({
      docker0: [{ family: 'IPv4', internal: false, address: '172.17.0.1' }],
      'vEthernet (WSL)': [{ family: 'IPv4', internal: false, address: '172.28.80.1' }]
    })
    const createMobilePairingOffer = vi.fn().mockResolvedValue({
      available: true,
      pairingUrl: 'orca://pair#relay',
      endpoint: 'ws://127.0.0.1:6768',
      deviceId: 'mobile-bridge-only',
      connectionMode: 'automatic'
    })

    registerMobileHandlers({ createMobilePairingOffer } as never)

    await expect(handlers.get('mobile:getPairingQR')?.(null, {})).resolves.toMatchObject({
      available: true,
      connectionMode: 'automatic',
      // Why: the offer's loopback fallback points at the scanning phone, not this host — reporting it
      // would print a direct endpoint under the QR that nothing can dial.
      endpoint: null
    })
    expect(createMobilePairingOffer).toHaveBeenCalledWith(
      expect.objectContaining({ address: null })
    )
    // The bridges stay pickable, just never automatically.
    await expect(handlers.get('mobile:listNetworkInterfaces')?.()).resolves.toEqual({
      interfaces: [
        { name: 'docker0', address: '172.17.0.1' },
        { name: 'vEthernet (WSL)', address: '172.28.80.1' }
      ]
    })
  })

  it('refuses a LAN-only QR on a bridge-only host instead of advertising the bridge', async () => {
    // Why: LAN has no Relay to fall back on, so a dead direct endpoint is worse than saying so —
    // the guidance points at the picker, where the bridge is still selectable on purpose.
    networkInterfacesMock.mockReturnValue({
      docker0: [{ family: 'IPv4', internal: false, address: '172.17.0.1' }]
    })
    const createMobilePairingOffer = vi.fn()

    registerMobileHandlers({ createMobilePairingOffer } as never)

    await expect(
      handlers.get('mobile:getPairingQR')?.(null, { connectionMode: 'local-only' })
    ).resolves.toMatchObject({
      available: false,
      reason: 'invalid_advertised_endpoint'
    })
    expect(createMobilePairingOffer).not.toHaveBeenCalled()
  })

  it('honors an explicitly picked bridge address', async () => {
    // Why: exclusion is about the automatic default only — a user who knows their bridge is routable
    // (a VM guest pairing with the host) must still be able to advertise it.
    networkInterfacesMock.mockReturnValue({
      docker0: [{ family: 'IPv4', internal: false, address: '172.17.0.1' }],
      en0: [{ family: 'IPv4', internal: false, address: '192.168.1.24' }]
    })
    const createMobilePairingOffer = vi.fn().mockResolvedValue({
      available: true,
      pairingUrl: 'orca://pair#bridge',
      endpoint: 'ws://172.17.0.1:6768',
      deviceId: 'mobile-bridge-pick',
      connectionMode: 'local-only'
    })

    registerMobileHandlers({ createMobilePairingOffer } as never)
    await handlers.get('mobile:getPairingQR')?.(null, {
      address: '172.17.0.1',
      connectionMode: 'local-only'
    })

    expect(createMobilePairingOffer).toHaveBeenCalledWith(
      expect.objectContaining({ address: '172.17.0.1' })
    )
  })

  it('returns an IPv6 interface on an IPv6-only host (regression: was empty, breaking mobile pairing)', async () => {
    networkInterfacesMock.mockReturnValue({
      eth0: [
        { family: 'IPv6', internal: false, address: '2605:340:cd51:2a01:0:2b13:f279:c096' },
        { family: 'IPv6', internal: false, address: 'fe80::42:acff:fe11:2' }
      ]
    })

    registerMobileHandlers({} as never)

    await expect(handlers.get('mobile:listNetworkInterfaces')?.()).resolves.toEqual({
      interfaces: [{ name: 'eth0', address: '2605:340:cd51:2a01:0:2b13:f279:c096' }]
    })
  })

  it('generates mobile pairing urls with the tailnet address by default', async () => {
    networkInterfacesMock.mockReturnValue({
      en0: [{ family: 'IPv4', internal: false, address: '192.168.1.24' }],
      utun4: [{ family: 'IPv4', internal: false, address: '100.102.47.57' }]
    })
    const createMobilePairingOffer = vi.fn().mockResolvedValue({
      available: true,
      pairingUrl: 'orca://pair#mobile',
      endpoint: 'ws://100.102.47.57:6768',
      deviceId: 'mobile-1',
      connectionMode: 'automatic'
    })
    const rpcServer = { createMobilePairingOffer }

    registerMobileHandlers(rpcServer as never)

    await expect(handlers.get('mobile:getPairingQR')?.(null, {})).resolves.toMatchObject({
      available: true,
      pairingUrl: 'orca://pair#mobile',
      endpoint: 'ws://100.102.47.57:6768',
      deviceId: 'mobile-1',
      connectionMode: 'automatic'
    })

    expect(createMobilePairingOffer).toHaveBeenCalledWith({
      address: '100.102.47.57',
      connectionMode: undefined,
      rotate: undefined,
      name: expect.stringMatching(/^Mobile /)
    })
  })

  it('forwards structured Relay mint failures to the renderer', async () => {
    networkInterfacesMock.mockReturnValue({
      en0: [{ family: 'IPv4', internal: false, address: '192.168.1.24' }]
    })
    const relayFailure = {
      code: 'relay_mint_failed',
      stage: 'create_pairing_relay',
      message: 'Relay pairing invite request failed'
    }
    const createMobilePairingOffer = vi.fn().mockResolvedValue({
      available: false,
      reason: 'relay_mint_failed',
      guidance: 'Use LAN or retry Relay.',
      relayFailure
    })

    registerMobileHandlers({ createMobilePairingOffer } as never)

    await expect(handlers.get('mobile:getPairingQR')?.(null, {})).resolves.toEqual({
      available: false,
      reason: 'relay_mint_failed',
      guidance: 'Use LAN or retry Relay.',
      relayFailure
    })
  })

  it('forwards an explicit local-only pairing choice', async () => {
    networkInterfacesMock.mockReturnValue({
      en0: [{ family: 'IPv4', internal: false, address: '192.168.1.24' }]
    })
    const createMobilePairingOffer = vi.fn().mockResolvedValue({
      available: true,
      pairingUrl: 'orca://pair#local',
      endpoint: 'ws://192.168.1.24:6768',
      deviceId: 'mobile-local',
      connectionMode: 'local-only'
    })

    registerMobileHandlers({ createMobilePairingOffer } as never)
    await handlers.get('mobile:getPairingQR')?.(null, { connectionMode: 'local-only' })

    expect(createMobilePairingOffer).toHaveBeenCalledWith(
      expect.objectContaining({ connectionMode: 'local-only' })
    )
  })

  it('preserves a copyable pairing URL when QR encoding fails', async () => {
    const createMobilePairingOffer = vi.fn().mockResolvedValue({
      available: true,
      pairingUrl: 'orca://pair?code=copy-me',
      endpoint: 'wss://pair.example/oversized',
      deviceId: 'mobile-large',
      connectionMode: 'local-only'
    })

    registerMobileHandlers({ createMobilePairingOffer } as never, {
      encodePairingQr: vi.fn().mockResolvedValue({ ok: false, reason: 'encoding_failed' })
    })

    await expect(
      handlers.get('mobile:getPairingQR')?.(null, { address: 'pair.example' })
    ).resolves.toEqual({
      available: true,
      qrDataUrl: null,
      qrError: 'encoding_failed',
      pairingUrl: 'orca://pair?code=copy-me',
      endpoint: 'wss://pair.example/oversized',
      deviceId: 'mobile-large',
      connectionMode: 'local-only'
    })
  })

  it('lists only paired mobile-scoped devices', () => {
    const rpcServer = {
      getDeviceRegistry: () => ({
        listDevices: () => [
          {
            deviceId: 'mobile-1',
            name: 'Phone',
            scope: 'mobile',
            pairedAt: 1,
            lastSeenAt: 2
          },
          {
            deviceId: 'runtime-1',
            name: 'CLI',
            scope: 'runtime',
            pairedAt: 1,
            lastSeenAt: 2
          },
          {
            deviceId: 'pending-mobile',
            name: 'Pending',
            scope: 'mobile',
            pairedAt: 1,
            lastSeenAt: 0
          }
        ]
      })
    }

    registerMobileHandlers(rpcServer as never)

    expect(handlers.get('mobile:listDevices')?.()).toEqual({
      devices: [
        {
          deviceId: 'mobile-1',
          name: 'Phone',
          pairedAt: 1,
          lastSeenAt: 2
        }
      ]
    })
  })

  it('generates runtime-scoped pairing urls for web and desktop clients', async () => {
    const createPairingOffer = vi.fn().mockReturnValue({
      available: true,
      pairingUrl: 'orca://pair#runtime',
      webClientUrl: 'http://100.64.1.20:6768/web-index.html?pairing=runtime',
      endpoint: 'ws://100.64.1.20:6768',
      deviceId: 'runtime-1'
    })
    const ensureNetworkExposure = vi.fn().mockResolvedValue(undefined)
    const rpcServer = { createPairingOffer, ensureNetworkExposure }

    registerMobileHandlers(rpcServer as never)

    await expect(
      handlers.get('mobile:getRuntimePairingUrl')?.(null, {
        address: '100.64.1.20',
        rotate: true
      })
    ).resolves.toEqual({
      available: true,
      pairingUrl: 'orca://pair#runtime',
      webClientUrl: 'http://100.64.1.20:6768/web-index.html?pairing=runtime',
      endpoint: 'ws://100.64.1.20:6768',
      deviceId: 'runtime-1'
    })

    expect(createPairingOffer).toHaveBeenCalledWith({
      address: '100.64.1.20',
      rotate: true,
      name: expect.stringMatching(/^Runtime /),
      scope: 'runtime',
      reach: 'network'
    })
    // Why: STA-2370 — generating a runtime offer must widen the listener BEFORE advertising its endpoint,
    // or a client could read the URL and connect before the LAN bind exists. Assert call ORDER, not just
    // that the widen ran, so a regression that widens after minting the offer is caught.
    expect(ensureNetworkExposure).toHaveBeenCalled()
    expect(ensureNetworkExposure.mock.invocationCallOrder[0]).toBeLessThan(
      createPairingOffer.mock.invocationCallOrder[0]
    )
  })

  const stubRuntimePairingServer = (
    address: string
  ): { createPairingOffer: Mock; ensureNetworkExposure: Mock } => ({
    createPairingOffer: vi.fn().mockReturnValue({
      available: true,
      pairingUrl: 'orca://pair#runtime',
      webClientUrl: `http://${address}/web-index.html?pairing=runtime`,
      endpoint: `ws://${address}`,
      deviceId: 'runtime-local'
    }),
    ensureNetworkExposure: vi.fn().mockResolvedValue(undefined)
  })

  it('reports runtime pairing unavailable rather than advertising a bridge', async () => {
    // Why: runtime clients have no Relay fallback, so a bridge-only host has nothing reachable to
    // advertise — and no widen should happen for a link that would be dead anyway.
    networkInterfacesMock.mockReturnValue({
      docker0: [{ family: 'IPv4', internal: false, address: '172.17.0.1' }]
    })
    const rpcServer = stubRuntimePairingServer('172.17.0.1:6768')

    registerMobileHandlers(rpcServer as never)

    await expect(handlers.get('mobile:getRuntimePairingUrl')?.(null, {})).resolves.toEqual({
      available: false
    })
    expect(rpcServer.createPairingOffer).not.toHaveBeenCalled()
    expect(rpcServer.ensureNetworkExposure).not.toHaveBeenCalled()
  })

  // Why: every loopback form the address field accepts must behave identically once the user declared
  // "This computer only" — `splitHostPort`/`ws://` overrides all reach the handler verbatim, so gating on
  // the raw string alone treated `localhost:8443` and `ws://127.0.0.1:6768` as off-host.
  it.each([
    '127.0.0.1',
    'localhost',
    '::1',
    '127.0.0.1:8443',
    'localhost:8443',
    '[::1]:6768',
    'ws://127.0.0.1:6768'
  ])('mints a %s runtime link without widening the listener off-host', async (address) => {
    const rpcServer = stubRuntimePairingServer(address)

    registerMobileHandlers(rpcServer as never)

    await expect(
      handlers.get('mobile:getRuntimePairingUrl')?.(null, {
        address,
        rotate: true,
        reach: 'this-computer'
      })
    ).resolves.toMatchObject({ available: true, deviceId: 'runtime-local' })

    // Why: "This computer only" exists so nothing is exposed off-host — a loopback link is already
    // served by the loopback listener, and the widen is one-way for the life of the process.
    expect(rpcServer.ensureNetworkExposure).not.toHaveBeenCalled()
    expect(rpcServer.createPairingOffer).toHaveBeenCalledWith(
      expect.objectContaining({ reach: 'this-computer' })
    )
  })

  // Why: the Custom field is documented as "SSH tunnel, reverse proxy, or custom hostname", so a loopback
  // front-end there still needs the listener open behind it — gating the widen on the address SHAPE broke
  // `ssh -L 8443:<desktop-lan-ip>:6768` (sshd dials the LAN address on this host and gets refused).
  it.each(['127.0.0.1:8443', 'localhost', 'ws://127.0.0.1:6768'])(
    'widens the listener for a custom %s address that fronts a tunnel',
    async (address) => {
      const rpcServer = stubRuntimePairingServer(address)

      registerMobileHandlers(rpcServer as never)

      await expect(
        handlers.get('mobile:getRuntimePairingUrl')?.(null, {
          address,
          rotate: true,
          reach: 'network'
        })
      ).resolves.toMatchObject({ available: true })

      expect(rpcServer.ensureNetworkExposure).toHaveBeenCalled()
      expect(rpcServer.createPairingOffer).toHaveBeenCalledWith(
        expect.objectContaining({ reach: 'network' })
      )
    }
  )

  it('widens for a loopback address when the caller declares no reach', async () => {
    const rpcServer = stubRuntimePairingServer('127.0.0.1:6768')

    registerMobileHandlers(rpcServer as never)

    await expect(
      handlers.get('mobile:getRuntimePairingUrl')?.(null, { address: '127.0.0.1', rotate: true })
    ).resolves.toMatchObject({ available: true })

    // Why: only an explicit "This computer only" declines remote reach; an undeclared caller keeps the
    // pre-STA-2370 opt-in behavior rather than silently minting a link the widen never backed.
    expect(rpcServer.ensureNetworkExposure).toHaveBeenCalled()
  })

  it('widens when a this-computer reach carries an off-host address', async () => {
    const rpcServer = stubRuntimePairingServer('192.168.1.5:6768')

    registerMobileHandlers(rpcServer as never)

    await expect(
      handlers.get('mobile:getRuntimePairingUrl')?.(null, {
        address: '192.168.1.5',
        rotate: true,
        reach: 'this-computer'
      })
    ).resolves.toMatchObject({ available: true })

    // Why: the declared reach and the advertised address disagree; honoring the declaration would mint a
    // LAN link with no LAN listener behind it, so the address it actually publishes wins.
    expect(rpcServer.ensureNetworkExposure).toHaveBeenCalled()
    expect(rpcServer.createPairingOffer).toHaveBeenCalledWith(
      expect.objectContaining({ reach: 'network' })
    )
  })

  it('reports the runtime pairing url unavailable and mints no offer when the widen fails', async () => {
    const createPairingOffer = vi.fn()
    // Why: STA-2370 — a failed widen leaves the listener on loopback, so the handler must NOT advertise a
    // LAN endpoint. A regression that swallows the rejection and mints an offer against a loopback-only
    // listener is caught here: createPairingOffer must never run.
    const ensureNetworkExposure = vi.fn().mockRejectedValue(new Error('bind refused'))
    const rpcServer = { createPairingOffer, ensureNetworkExposure }

    registerMobileHandlers(rpcServer as never)

    await expect(
      handlers.get('mobile:getRuntimePairingUrl')?.(null, { address: '100.64.1.20' })
    ).resolves.toEqual({
      available: false,
      reason: 'network_exposure_failed',
      guidance: NETWORK_EXPOSURE_FAILED_GUIDANCE
    })

    expect(ensureNetworkExposure).toHaveBeenCalled()
    expect(createPairingOffer).not.toHaveBeenCalled()
  })

  it('lists runtime access grants including unused generated links', () => {
    const rpcServer = {
      getDeviceRegistry: () => ({
        listDevices: () => [
          {
            deviceId: 'mobile-1',
            name: 'Phone',
            scope: 'mobile',
            pairedAt: 1,
            lastSeenAt: 2
          },
          {
            deviceId: 'runtime-1',
            name: 'Browser',
            scope: 'runtime',
            pairedAt: 3,
            lastSeenAt: 4
          },
          {
            deviceId: 'pending-runtime',
            name: 'Copied link',
            scope: 'runtime',
            pairedAt: 5,
            lastSeenAt: 0
          }
        ]
      })
    }

    registerMobileHandlers(rpcServer as never)

    expect(handlers.get('mobile:listRuntimeAccessGrants')?.()).toEqual({
      grants: [
        {
          deviceId: 'pending-runtime',
          name: 'Copied link',
          createdAt: 5,
          lastSeenAt: null
        },
        {
          deviceId: 'runtime-1',
          name: 'Browser',
          createdAt: 3,
          lastSeenAt: 4
        }
      ]
    })
  })

  it('revokes runtime access through the runtime server', () => {
    const revokeRuntimeAccess = vi.fn().mockReturnValue(true)
    const rpcServer = {
      getDeviceRegistry: () => ({}),
      revokeRuntimeAccess
    }

    registerMobileHandlers(rpcServer as never)

    expect(handlers.get('mobile:revokeRuntimeAccess')?.(null, { deviceId: 'runtime-1' })).toEqual({
      revoked: true
    })
    expect(revokeRuntimeAccess).toHaveBeenCalledWith('runtime-1')
  })

  it('awaits mobile device revocation before replying', async () => {
    const revokeMobileDevice = vi.fn().mockResolvedValue(true)
    const rpcServer = {
      getDeviceRegistry: () => ({}),
      revokeMobileDevice
    }

    registerMobileHandlers(rpcServer as never)

    await expect(
      handlers.get('mobile:revokeDevice')?.(null, { deviceId: 'mobile-1' })
    ).resolves.toEqual({ revoked: true })
    expect(revokeMobileDevice).toHaveBeenCalledWith('mobile-1')
  })

  it('reports the current relay broker status without exposing a toggle', () => {
    registerMobileHandlers({} as never, { getRelayStatus: () => 'registered' })

    expect(handlers.get('mobile:getRelayStatus')?.()).toEqual({ status: 'registered' })
  })

  it('consumes a pending auth-failure notification only from a window renderer', () => {
    const consumePendingUnpairedDeviceAuthFailure = vi.fn(() => true)
    registerMobileHandlers({} as never, { consumePendingUnpairedDeviceAuthFailure })

    expect(
      handlers.get('mobile:consumePendingUnpairedDeviceAuthFailure')?.({
        sender: { id: 42, isDestroyed: () => false, getType: () => 'window' }
      })
    ).toBe(true)
    expect(consumePendingUnpairedDeviceAuthFailure).toHaveBeenCalledWith(42)

    expect(
      handlers.get('mobile:consumePendingUnpairedDeviceAuthFailure')?.({
        sender: { id: 99, isDestroyed: () => false, getType: () => 'webview' }
      })
    ).toBe(false)
    expect(consumePendingUnpairedDeviceAuthFailure).toHaveBeenCalledOnce()
  })

  it('inspects and repairs the current packaged Windows websocket port', async () => {
    const runPowerShell = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({
          ruleAllowed: false,
          privateFirewallEnabled: true,
          networkCategory: 'Private'
        })
      )
      .mockResolvedValueOnce('{"launched":true,"exitCode":0}')
    const rpcServer = { getWebSocketEndpoint: () => 'ws://0.0.0.0:6768' }
    registerMobileHandlers(rpcServer as never, {
      firewallEnvironment: {
        platform: 'win32',
        isPackaged: true,
        executablePath: 'C:\\Program Files\\Orca\\Orca.exe',
        runPowerShell
      }
    })

    await expect(
      handlers.get('mobile:getWindowsFirewallStatus')?.(null, { address: '192.168.0.108' })
    ).resolves.toMatchObject({ supported: true, port: 6768, ruleAllowed: false })
    await expect(
      handlers.get('mobile:repairWindowsFirewall')?.({
        sender: { isDestroyed: () => false, getType: () => 'window' }
      })
    ).resolves.toEqual({ ok: true })
  })

  it('rejects firewall mutation from a non-window renderer', async () => {
    const runPowerShell = vi.fn()
    const rpcServer = { getWebSocketEndpoint: () => 'ws://0.0.0.0:6768' }
    registerMobileHandlers(rpcServer as never, {
      firewallEnvironment: {
        platform: 'win32',
        isPackaged: true,
        executablePath: 'C:\\Program Files\\Orca\\Orca.exe',
        runPowerShell
      }
    })

    expect(
      handlers.get('mobile:repairWindowsFirewall')?.({
        sender: { isDestroyed: () => false, getType: () => 'webview' }
      })
    ).toEqual({ ok: false, reason: 'unsupported' })
    expect(runPowerShell).not.toHaveBeenCalled()
  })
})

describe('runtime pairing bind host', () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>()

  const wsTransportOf = (server: OrcaRuntimeRpcServer): WebSocketTransport | undefined =>
    (server['activeTransports'] as unknown[]).find(
      (transport): transport is WebSocketTransport => transport instanceof WebSocketTransport
    )

  beforeEach(() => {
    handlers.clear()
    handleMock.mockReset()
    networkInterfacesMock.mockReset()
    networkInterfacesMock.mockReturnValue({})
    handleMock.mockImplementation((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler)
    })
  })

  const startServer = async (userDataPath: string): Promise<OrcaRuntimeRpcServer> => {
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: true,
      wsPort: 0
    })
    await server.start()
    return server
  }

  it('keeps a real listener on loopback for a local link and widens it only for an off-host one', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-mobile-ipc-'))
    const server = await startServer(userDataPath)

    try {
      registerMobileHandlers(server)
      expect(wsTransportOf(server)?.resolvedHost).toBe('127.0.0.1')

      await expect(
        handlers.get('mobile:getRuntimePairingUrl')?.(null, {
          address: '127.0.0.1',
          rotate: true,
          reach: 'this-computer'
        })
      ).resolves.toMatchObject({ available: true })
      // Why: the exposure regression — picking "This computer only" used to rebind the listener to
      // 0.0.0.0 and leave it there, publishing the runtime to the whole LAN for the rest of the process.
      expect(wsTransportOf(server)?.resolvedHost).toBe('127.0.0.1')

      await expect(
        handlers.get('mobile:getRuntimePairingUrl')?.(null, {
          address: '100.64.1.20',
          rotate: true,
          reach: 'network'
        })
      ).resolves.toMatchObject({ available: true })
      // Why: the LAN/Tailscale choice still opts in — a client off this host cannot reach a loopback bind.
      expect(wsTransportOf(server)?.resolvedHost).toBe('0.0.0.0')
    } finally {
      await server.stop()
    }
  })

  // Why: the whole guarantee is worthless if it lasts one process — the local web client authenticating
  // marks its grant lastSeenAt > 0, which used to make the NEXT launch bind every interface.
  it('still binds loopback on the next launch after the local link has been used', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-mobile-ipc-'))
    const server = await startServer(userDataPath)
    let deviceId: string
    try {
      registerMobileHandlers(server)
      const offer = (await handlers.get('mobile:getRuntimePairingUrl')?.(null, {
        address: '127.0.0.1',
        rotate: true,
        reach: 'this-computer'
      })) as { available: true; deviceId: string }
      expect(offer.available).toBe(true)
      deviceId = offer.deviceId
      // Exactly what MobileSocketWiring does for every authenticated socket, local browser included.
      server.getDeviceRegistry()?.updateLastSeen(deviceId)
    } finally {
      await server.stop()
    }

    const relaunched = await startServer(userDataPath)
    try {
      expect(
        relaunched
          .getDeviceRegistry()
          ?.listDevices()
          .some((device) => device.deviceId === deviceId && device.lastSeenAt > 0)
      ).toBe(true)
      expect(wsTransportOf(relaunched)?.resolvedHost).toBe('127.0.0.1')
    } finally {
      await relaunched.stop()
    }
  })

  it('binds all interfaces on the next launch after a network link has been used', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-mobile-ipc-'))
    const server = await startServer(userDataPath)
    try {
      registerMobileHandlers(server)
      const offer = (await handlers.get('mobile:getRuntimePairingUrl')?.(null, {
        address: '100.64.1.20',
        rotate: true,
        reach: 'network'
      })) as { available: true; deviceId: string }
      expect(offer.available).toBe(true)
      server.getDeviceRegistry()?.updateLastSeen(offer.deviceId)
    } finally {
      await server.stop()
    }

    const relaunched = await startServer(userDataPath)
    try {
      // Why: the reconnect widen must survive — a client that really did connect from off-host has to
      // find the listener at launch without the user re-pairing.
      expect(wsTransportOf(relaunched)?.resolvedHost).toBe('0.0.0.0')
    } finally {
      await relaunched.stop()
    }
  })
})
