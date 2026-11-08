import { mkdtempSync } from 'node:fs'

import { tmpdir } from 'node:os'

import { join } from 'node:path'

import { describe, expect, it, vi } from 'vitest'

import { DeviceRegistry } from './device-registry'

import { OrcaRuntimeService } from '../../../orca-runtime'

import { createOwnerPairingOffer, type PairingOfferServer } from './pairing-offer-requests'

import { OrcaRuntimeRpcServer } from '../runtime-rpc'

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
      webClientUrl: null,
      offerExpiresAt: null
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
