import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DeviceRegistry } from './device-registry'
import { OrcaRuntimeService } from './orca-runtime'
import { createOwnerPairingOffer, type PairingOfferServer } from './pairing-offer-requests'
import { OrcaRuntimeRpcServer } from './runtime-rpc'

function serverWithRegistry(): OrcaRuntimeRpcServer {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-owner-pairing-'))
  const server = new OrcaRuntimeRpcServer({
    runtime: new OrcaRuntimeService(),
    userDataPath,
    enableWebSocket: false
  })
  server['deviceRegistry'] = new DeviceRegistry(userDataPath)
  return server
}

describe('pairing.createOffer', () => {
  it('reaches the pairing service for the owner CLI on the local transport', async () => {
    const server = serverWithRegistry()
    const reply = await server['handleMessage'](
      JSON.stringify({
        id: 'req-pair',
        method: 'pairing.createOffer',
        authToken: server['authToken'],
        params: { scope: 'mobile', address: '100.64.1.20' }
      })
    )
    // No WebSocket listener in this server, so the service answers with a reason instead of an offer.
    expect(reply).toMatchObject({
      ok: true,
      result: { available: false, reason: 'websocket_unavailable' }
    })
  })

  it.each(['runtime', 'mobile'] as const)('is refused to a paired %s client', async (scope) => {
    const server = serverWithRegistry()
    const device = server['deviceRegistry']!.addDevice('client', scope)
    const replies: { ok: boolean; error?: { code: string } }[] = []
    await server['handleWebSocketMessage'](
      JSON.stringify({
        id: 'req-pair',
        method: 'pairing.createOffer',
        deviceToken: device.token,
        params: { scope: 'mobile' }
      }),
      (response) => replies.push(JSON.parse(response)),
      () => {}
    )
    expect(replies[0]?.ok).toBe(false)
    expect(server['deviceRegistry']!.listDevices()).toHaveLength(1)
  })
})

describe('owner pairing offers', () => {
  function fakeServer(): PairingOfferServer {
    const available = {
      available: true as const,
      pairingUrl: 'orca://pair#offer',
      endpoint: 'ws://100.64.1.20:6768',
      deviceId: 'd1',
      webClientUrl: null
    }
    return {
      getNetworkExposureBindHost: () => '0.0.0.0',
      ensureNetworkExposure: vi.fn(async () => {}),
      createPairingOffer: vi.fn(() => available),
      createMobilePairingOffer: vi.fn(async (args) => ({
        ...available,
        connectionMode: args.connectionMode ?? 'automatic'
      }))
    }
  }

  it('keeps phones on the LAN unless Relay is asked for', async () => {
    const server = fakeServer()
    const lan = await createOwnerPairingOffer(server, { scope: 'mobile', address: '100.64.1.20' })
    const relay = await createOwnerPairingOffer(server, {
      scope: 'mobile',
      address: '100.64.1.20',
      relay: true
    })
    expect(lan).toMatchObject({ available: true, connectionMode: 'local-only' })
    expect(relay).toMatchObject({ available: true, connectionMode: 'automatic' })
  })

  it('grants desktop control only when asked, and widens before advertising', async () => {
    const server = fakeServer()
    await createOwnerPairingOffer(server, {
      scope: 'runtime',
      address: '100.64.1.20',
      grantDesktopControl: true
    })
    expect(server.ensureNetworkExposure).toHaveBeenCalled()
    expect(server.createPairingOffer).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'runtime', grants: ['desktop-control'], reach: 'network' })
    )
  })

  it('reports a failed widening instead of advertising an unreachable address', async () => {
    const server = fakeServer()
    server.ensureNetworkExposure = vi.fn(async () => {
      throw new Error('bind failed')
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(
      await createOwnerPairingOffer(server, { scope: 'runtime', address: '100.64.1.20' })
    ).toMatchObject({ available: false, reason: 'network_exposure_failed' })
    expect(server.createPairingOffer).not.toHaveBeenCalled()
  })
})
