import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceRegistry } from './device-registry'
import { getPairingNetworkInterfaces } from './pairing-network-interfaces'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { createMobileRpcSurfaceRuntime } from './runtime-rpc-mobile-method-allowlist-fixtures'

vi.mock('./pairing-network-interfaces', () => ({ getPairingNetworkInterfaces: vi.fn() }))

describe('paired direct endpoint discovery', () => {
  let directory: string
  let server: OrcaRuntimeRpcServer
  let token: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'orca-direct-discovery-'))
    const { runtime } = createMobileRpcSurfaceRuntime()
    server = new OrcaRuntimeRpcServer({ runtime, userDataPath: directory, enableWebSocket: false })
    const registry = new DeviceRegistry(directory)
    const device = registry.addDevice('phone', 'mobile')
    registry.setMobilePairingConnectionMode(device.deviceId, 'local-only')
    server['deviceRegistry'] = registry
    server['transports'] = [{ kind: 'websocket', endpoint: 'ws://0.0.0.0:6768' }]
    token = device.token
    vi.mocked(getPairingNetworkInterfaces).mockResolvedValue([
      { name: 'en0', address: '192.168.10.20' }
    ])
  })

  afterEach(() => {
    vi.resetAllMocks()
    rmSync(directory, { recursive: true, force: true })
  })

  async function request(deviceToken = token, params: unknown = {}): Promise<unknown> {
    let response: unknown
    await server['handleWebSocketMessage'](
      JSON.stringify({ id: 'discover', method: 'pairing.getDirectEndpoints', deviceToken, params }),
      (raw) => {
        response = JSON.parse(raw)
      },
      () => {}
    )
    return response
  }

  it('serves LAN-only pairings without an Orca Cloud relay provider', async () => {
    await expect(request()).resolves.toMatchObject({
      ok: true,
      result: { v: 1, endpoints: [{ kind: 'lan', url: 'ws://192.168.10.20:6768' }] }
    })
  })

  it('reads the current interface and bound port on each request', async () => {
    await request()
    vi.mocked(getPairingNetworkInterfaces).mockResolvedValue([
      { name: 'en0', address: '10.20.30.40' }
    ])
    server['transports'] = [{ kind: 'websocket', endpoint: 'ws://0.0.0.0:6769' }]

    await expect(request()).resolves.toMatchObject({
      ok: true,
      result: { v: 1, endpoints: [{ kind: 'lan', url: 'ws://10.20.30.40:6769' }] }
    })
  })

  it('does not inspect interfaces before authenticating the paired device', async () => {
    await expect(request('not-a-device-token')).resolves.toMatchObject({
      ok: false,
      error: { code: 'unauthorized' }
    })
    expect(getPairingNetworkInterfaces).not.toHaveBeenCalled()
  })

  it('does not widen a listener bound only to loopback', async () => {
    server['transports'] = [{ kind: 'websocket', endpoint: 'ws://127.0.0.1:6768' }]
    await expect(request()).resolves.toMatchObject({ ok: true, result: { v: 1, endpoints: [] } })
    expect(server.getWebSocketEndpoint()).toBe('ws://127.0.0.1:6768')
    expect(getPairingNetworkInterfaces).not.toHaveBeenCalled()
  })

  it('refuses caller-selected addresses', async () => {
    await expect(request(token, { address: '192.168.10.99' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'invalid_argument' }
    })
    expect(getPairingNetworkInterfaces).not.toHaveBeenCalled()
  })
})
