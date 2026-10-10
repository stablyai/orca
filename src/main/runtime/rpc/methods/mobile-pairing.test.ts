import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import { OrcaRuntimeRpcServer } from '../../runtime-rpc'
import { MOBILE_PAIRING_METHODS } from './mobile-pairing'
import { buildRegistry } from '../core'
import type { MobilePairingRpcAccessors } from './mobile-pairing'

vi.mock('../../../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([]),
  listWorktreesStrict: vi.fn().mockResolvedValue([])
}))

// Why: each test gets a unique accessor with the right shape so handler logic runs without hitting the
// real QR encoder or pairing code paths.
function createAccessors(server: OrcaRuntimeRpcServer): MobilePairingRpcAccessors {
  return {
    getWebSocketEndpoint: () => server.getWebSocketEndpoint(),
    getPairingNetworkInterfaces: async () => [],
    getDefaultPairingAddress: async () => null,
    createMobilePairingOffer: async () => ({
      available: false as const,
      reason: 'mock_unavailable',
      guidance: 'mock'
    }),
    createPairingOffer: () => ({ available: false as const, reason: 'mock', guidance: 'mock' }),
    getDeviceRegistry: () => server.getDeviceRegistry(),
    revokeMobileDevice: async () => false,
    isDesktopRelayProviderAttached: () => false,
    encodePairingQr: async () => ({
      ok: true as const,
      qrDataUrl: 'data:image/png;base64,AAAA',
      qrSize: 200
    })
  }
}

async function createRuntimeWithDevice(scope: 'runtime' | 'mobile' = 'runtime') {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-mobile-pairing-rpc-'))
  const runtime = new OrcaRuntimeService()
  const server = new OrcaRuntimeRpcServer({
    runtime,
    userDataPath,
    enableWebSocket: true,
    wsPort: 0
  })
  await server.start()
  const registry = server.getDeviceRegistry()!
  const device = registry.addDevice('test-device', scope)
  const accessors = createAccessors(server)
  runtime.setMobilePairingRpcAccessors(accessors)
  return { userDataPath, runtime, server, device, accessors }
}

async function dispatch<T extends Record<string, unknown> = Record<string, unknown>>(
  server: OrcaRuntimeRpcServer,
  request: Record<string, unknown>
): Promise<T> {
  const replies: T[] = []
  await server['handleWebSocketMessage'](
    JSON.stringify(request),
    (response) => {
      const parsed: T = JSON.parse(response)
      replies.push(parsed)
    },
    () => {}
  )
  if (replies.length === 0) {
    throw new Error('expected a reply but got none')
  }
  return replies.at(-1)!
}

describe('MOBILE_PAIRING_METHODS manifest', () => {
  it('exposes the six mobile.* methods required by the contract', () => {
    expect(MOBILE_PAIRING_METHODS.map((m) => m.name).sort()).toEqual([
      'mobile.getPairingQR',
      'mobile.getRuntimePairingUrl',
      'mobile.hostStatus',
      'mobile.listDevices',
      'mobile.listNetworkInterfaces',
      'mobile.revokeDevice'
    ])
  })

  it('registers into a registry without collisions', () => {
    const registry = buildRegistry(MOBILE_PAIRING_METHODS)
    expect([...registry.keys()].sort()).toEqual([
      'mobile.getPairingQR',
      'mobile.getRuntimePairingUrl',
      'mobile.hostStatus',
      'mobile.listDevices',
      'mobile.listNetworkInterfaces',
      'mobile.revokeDevice'
    ])
  })
})

describe('mobile pairing RPC wiring', () => {
  let server: OrcaRuntimeRpcServer | null = null

  afterEach(async () => {
    if (server) {
      await server.stop()
      server = null
    }
  })

  it('delegates createPairingOffer to the server, reusing the pending offer across calls', async () => {
    // runtime-rpc-pairing.ts uses getOrCreatePendingDevice, so identical args return the
    // same deviceId until the offer is rotated — the delegation orcad-entry installs must
    // preserve that reuse semantics.
    const ctx = await createRuntimeWithDevice()
    server = ctx.server
    const accessors = ctx.accessors
    const delegating: MobilePairingRpcAccessors = {
      ...accessors,
      createPairingOffer: (args) => server!.createPairingOffer(args)
    }
    const first = delegating.createPairingOffer({ name: 'delegate-test' })
    const second = delegating.createPairingOffer({ name: 'delegate-test' })
    const direct = ctx.server.createPairingOffer({ name: 'delegate-test' })
    expect(first.available).toBe(true)
    expect(direct.available).toBe(true)
    if (first.available && second.available && direct.available) {
      expect(second.deviceId).toBe(first.deviceId)
      expect(direct.deviceId).toBe(first.deviceId)
    }
  })
})

describe('mobile.hostStatus', () => {
  let server: OrcaRuntimeRpcServer | null = null

  afterEach(async () => {
    if (server) {
      await server.stop()
      server = null
    }
  })

  it('reports hostMode: desktop when a live renderer is attached', async () => {
    const ctx = await createRuntimeWithDevice()
    server = ctx.server
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: getAvailableAuthoritativeWindow is a protected class-member the test must stub to simulate an attached renderer.
    ;(
      ctx.runtime as unknown as { getAvailableAuthoritativeWindow: () => unknown }
    ).getAvailableAuthoritativeWindow = () => ({})
    const reply = await dispatch(ctx.server, {
      id: 'hostStatus_desktop',
      method: 'mobile.hostStatus',
      deviceToken: ctx.device.token
    })
    expect(reply).toMatchObject({
      ok: true,
      result: expect.objectContaining({
        hostMode: 'desktop',
        relayAvailable: false,
        webSocketEndpoint: expect.any(String)
      })
    })
  })

  it('reports hostMode: serve when no renderer exists', async () => {
    const ctx = await createRuntimeWithDevice()
    server = ctx.server
    const reply = await dispatch(ctx.server, {
      id: 'hostStatus_serve',
      method: 'mobile.hostStatus',
      deviceToken: ctx.device.token
    })
    expect(reply).toMatchObject({
      ok: true,
      result: expect.objectContaining({ hostMode: 'serve', relayAvailable: false })
    })
  })

  it('reports webSocketEndpoint: null when the WS listener is down', async () => {
    // Why: enableWebSocket: true + the mock accessor returning null mirrors a host that started the
    // WS transport but the listener was already torn down — the test still proves the field is null.
    const ctx = await createRuntimeWithDevice()
    server = ctx.server
    ctx.accessors.getWebSocketEndpoint = () => null
    runtime_setAccessors(ctx.runtime, ctx.accessors)
    const reply = await dispatch(ctx.server, {
      id: 'hostStatus_no_ws',
      method: 'mobile.hostStatus',
      deviceToken: ctx.device.token
    })
    expect(reply).toMatchObject({
      ok: true,
      result: expect.objectContaining({ webSocketEndpoint: null })
    })
  })

  it('reports relayAvailable: true only when the relay provider is attached', async () => {
    const ctx = await createRuntimeWithDevice()
    server = ctx.server
    ctx.accessors.isDesktopRelayProviderAttached = () => true
    runtime_setAccessors(ctx.runtime, ctx.accessors)
    const reply = await dispatch(ctx.server, {
      id: 'hostStatus_relay',
      method: 'mobile.hostStatus',
      deviceToken: ctx.device.token
    })
    expect(reply).toMatchObject({
      ok: true,
      result: expect.objectContaining({ relayAvailable: true })
    })
  })
})

function runtime_setAccessors(
  runtime: OrcaRuntimeService,
  accessors: MobilePairingRpcAccessors
): void {
  runtime.setMobilePairingRpcAccessors(accessors)
}

describe('mobile.listDevices', () => {
  let server: OrcaRuntimeRpcServer | null = null

  afterEach(async () => {
    if (server) {
      await server.stop()
      server = null
    }
  })

  it('filters out pending (lastSeenAt === 0) and non-mobile scope devices', async () => {
    const ctx = await createRuntimeWithDevice()
    server = ctx.server
    const registry = ctx.server.getDeviceRegistry()!
    const pairedMobile = registry.getOrCreatePendingDevice('Paired mobile', 'mobile')
    registry.updateLastSeen(pairedMobile.deviceId)
    // Why: rotatePendingDevice mints a fresh pending token while preserving the existing device,
    // exercising the never-scanned (lastSeenAt === 0) filter.
    const pendingMobile = registry.rotatePendingDevice('Pending mobile', 'mobile', 'network')
    const runtimeDevice = registry.getOrCreatePendingDevice('Runtime device', 'runtime')
    registry.updateLastSeen(runtimeDevice.deviceId)

    const reply = await dispatch<{ ok: true; result: { devices: { deviceId: string }[] } }>(
      ctx.server,
      {
        id: 'listDevices_filter',
        method: 'mobile.listDevices',
        deviceToken: ctx.device.token
      }
    )
    expect(reply).toMatchObject({ ok: true })
    const result = reply.result
    const ids = result.devices.map((d) => d.deviceId).sort()
    expect(ids).toEqual([pairedMobile.deviceId].sort())
    expect(ids).not.toContain(pendingMobile.deviceId)
  })
})

describe('mobile.revokeDevice', () => {
  let server: OrcaRuntimeRpcServer | null = null

  afterEach(async () => {
    if (server) {
      await server.stop()
      server = null
    }
  })

  it('returns { revoked: false } for unknown or non-mobile devices', async () => {
    const ctx = await createRuntimeWithDevice()
    server = ctx.server
    const registry = ctx.server.getDeviceRegistry()!
    const runtimeDevice = registry.getOrCreatePendingDevice('Runtime device', 'runtime')
    registry.updateLastSeen(runtimeDevice.deviceId)

    const replyUnknown = await dispatch(ctx.server, {
      id: 'revoke_unknown',
      method: 'mobile.revokeDevice',
      deviceToken: ctx.device.token,
      params: { deviceId: 'not-a-real-device' }
    })
    expect(replyUnknown).toMatchObject({ ok: true, result: { revoked: false } })

    const replyRuntime = await dispatch(ctx.server, {
      id: 'revoke_runtime',
      method: 'mobile.revokeDevice',
      deviceToken: ctx.device.token,
      params: { deviceId: runtimeDevice.deviceId }
    })
    expect(replyRuntime).toMatchObject({ ok: true, result: { revoked: false } })
  })
})

describe('mobile.getPairingQR', () => {
  let server: OrcaRuntimeRpcServer | null = null

  afterEach(async () => {
    if (server) {
      await server.stop()
      server = null
    }
  })

  it('fails closed with invalid_advertised_endpoint when local-only and no IP is available', async () => {
    const ctx = await createRuntimeWithDevice()
    server = ctx.server
    ctx.accessors.getDefaultPairingAddress = async () => null
    runtime_setAccessors(ctx.runtime, ctx.accessors)
    const reply = await dispatch(ctx.server, {
      id: 'qr_local_only',
      method: 'mobile.getPairingQR',
      deviceToken: ctx.device.token,
      params: { connectionMode: 'local-only' }
    })
    expect(reply).toMatchObject({
      ok: true,
      result: {
        available: false,
        reason: 'invalid_advertised_endpoint',
        guidance: expect.any(String)
      }
    })
  })

  it('widens before advertising (returns unavailable on network exposure failure)', async () => {
    const ctx = await createRuntimeWithDevice()
    server = ctx.server
    ctx.accessors.createMobilePairingOffer = async () => ({
      available: false as const,
      reason: 'network_exposure_failed',
      guidance: 'widen failed'
    })
    runtime_setAccessors(ctx.runtime, ctx.accessors)
    const reply = await dispatch(ctx.server, {
      id: 'qr_widen_failed',
      method: 'mobile.getPairingQR',
      deviceToken: ctx.device.token
    })
    expect(reply).toMatchObject({
      ok: true,
      result: { available: false, reason: 'network_exposure_failed' }
    })
  })

  it('returns the QR payload when an offer is available', async () => {
    const ctx = await createRuntimeWithDevice()
    server = ctx.server
    ctx.accessors.getDefaultPairingAddress = async () => '192.168.1.10'
    ctx.accessors.createMobilePairingOffer = async () => ({
      available: true as const,
      pairingUrl: 'pair://example',
      endpoint: 'ws://192.168.1.10:9999',
      deviceId: 'd-1',
      connectionMode: 'automatic' as const
    })
    runtime_setAccessors(ctx.runtime, ctx.accessors)
    const reply = await dispatch(ctx.server, {
      id: 'qr_ok',
      method: 'mobile.getPairingQR',
      deviceToken: ctx.device.token
    })
    expect(reply).toMatchObject({
      ok: true,
      result: {
        available: true,
        qrDataUrl: expect.any(String),
        pairingUrl: 'pair://example',
        endpoint: 'ws://192.168.1.10:9999',
        deviceId: 'd-1',
        connectionMode: 'automatic'
      }
    })
  })
})

describe('mobile.listNetworkInterfaces', () => {
  let server: OrcaRuntimeRpcServer | null = null

  afterEach(async () => {
    if (server) {
      await server.stop()
      server = null
    }
  })

  it('returns the accessor interface list', async () => {
    const ctx = await createRuntimeWithDevice()
    server = ctx.server
    ctx.accessors.getPairingNetworkInterfaces = async () => [
      { name: 'en0', address: '192.168.1.10', family: 'IPv4' as const }
    ]
    runtime_setAccessors(ctx.runtime, ctx.accessors)
    const reply = await dispatch(ctx.server, {
      id: 'list_interfaces',
      method: 'mobile.listNetworkInterfaces',
      deviceToken: ctx.device.token
    })
    expect(reply).toMatchObject({
      ok: true,
      result: { interfaces: [{ name: 'en0', address: '192.168.1.10', family: 'IPv4' }] }
    })
  })
})

describe('mobile.getRuntimePairingUrl', () => {
  let server: OrcaRuntimeRpcServer | null = null

  afterEach(async () => {
    if (server) {
      await server.stop()
      server = null
    }
  })

  it('returns { available: false } when no IP is available', async () => {
    const ctx = await createRuntimeWithDevice()
    server = ctx.server
    ctx.accessors.getDefaultPairingAddress = async () => null
    runtime_setAccessors(ctx.runtime, ctx.accessors)
    const reply = await dispatch(ctx.server, {
      id: 'runtime_url_unavailable',
      method: 'mobile.getRuntimePairingUrl',
      deviceToken: ctx.device.token
    })
    expect(reply).toMatchObject({ ok: true, result: { available: false } })
  })
})

describe('mobile-scope rejection', () => {
  let server: OrcaRuntimeRpcServer | null = null

  beforeEach(() => {
    // Why: each describe block already has its own server lifecycle; only the dispatcher test
    // here runs without starting its own server.
  })

  afterEach(async () => {
    if (server) {
      await server.stop()
      server = null
    }
  })

  it('rejects every mobile.* method with forbidden when the deviceToken has mobile scope', async () => {
    const ctx = await createRuntimeWithDevice('mobile')
    server = ctx.server
    const methods = [
      { method: 'mobile.hostStatus' },
      { method: 'mobile.listNetworkInterfaces' },
      { method: 'mobile.getPairingQR', params: {} },
      { method: 'mobile.listDevices' },
      { method: 'mobile.revokeDevice', params: { deviceId: 'x' } },
      { method: 'mobile.getRuntimePairingUrl', params: {} }
    ]
    for (const { method, params } of methods) {
      const reply = await dispatch(ctx.server, {
        id: `req_${method}`,
        method,
        deviceToken: ctx.device.token,
        ...(params !== undefined ? { params } : {})
      })
      expect(reply).toMatchObject({
        ok: false,
        error: expect.objectContaining({ code: 'forbidden' })
      })
    }
  })
})
