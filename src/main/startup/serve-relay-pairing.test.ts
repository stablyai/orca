import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRelayPairing } from '../runtime/runtime-rpc/runtime-rpc-pairing-types'
import { createServeRelayPairingOffer } from './serve-relay-pairing'

const { getOrcaCloudAuthConfig, readRelayAuthContext } = vi.hoisted(() => ({
  getOrcaCloudAuthConfig: vi.fn(),
  readRelayAuthContext: vi.fn()
}))

vi.mock('../orca-profiles/profile-cloud-auth-config', () => ({ getOrcaCloudAuthConfig }))
vi.mock('../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/tmp/orca-profile'
}))
vi.mock('../runtime/relay/relay-auth-context', () => ({ readRelayAuthContext }))

const direct = {
  available: true as const,
  pairingUrl: 'orca://pair?code=direct',
  endpoint: 'ws://100.64.1.20:6768',
  deviceId: 'device-1',
  webClientUrl: null
}

function server(relay: RuntimeRelayPairing) {
  return {
    createPairingOffer: vi.fn(() => direct),
    createRuntimeRelayPairingOffer: vi.fn(async () => ({ ...direct, relay }))
  }
}

const unusedRelay: RuntimeRelayPairing = {
  available: false,
  failure: { code: 'relay_unused', stage: 'provider_missing', message: 'unused' }
}

const args = { address: '100.64.1.20', name: 'CLI test' }

describe('createServeRelayPairingOffer', () => {
  beforeEach(() => {
    getOrcaCloudAuthConfig.mockReturnValue({ configured: true, config: {} })
    readRelayAuthContext.mockResolvedValue({ relayEntitled: true })
  })

  it.each([
    [null, 'relay_sign_in_required'],
    [{ relayEntitled: false }, 'relay_not_entitled']
  ])('names the missing account step and keeps the direct link', async (context, code) => {
    readRelayAuthContext.mockResolvedValue(context)
    const rpc = server(unusedRelay)

    await expect(createServeRelayPairingOffer(rpc, args)).resolves.toEqual({
      ...direct,
      relay: { available: false, code, guidance: expect.any(String) }
    })
    expect(rpc.createRuntimeRelayPairingOffer).not.toHaveBeenCalled()
    expect(rpc.createPairingOffer).toHaveBeenCalledWith({ ...args, scope: 'runtime' })
  })

  it('reports an unconfigured cloud build without minting', async () => {
    getOrcaCloudAuthConfig.mockReturnValue({ configured: false, setupMessage: 'Not configured.' })

    await expect(createServeRelayPairingOffer(server(unusedRelay), args)).resolves.toMatchObject({
      relay: { available: false, code: 'relay_cloud_unconfigured', guidance: 'Not configured.' }
    })
  })

  it('lets the mint decide after a transient account read failure', async () => {
    readRelayAuthContext.mockRejectedValue(new Error('network'))
    const rpc = server({
      available: false,
      failure: { code: 'relay_control_not_active', stage: 'create_pairing_relay', message: 'x' }
    })

    await expect(createServeRelayPairingOffer(rpc, args)).resolves.toMatchObject({
      relay: { available: false, code: 'relay_control_not_active' }
    })
    expect(rpc.createRuntimeRelayPairingOffer).toHaveBeenCalledWith(args)
  })

  it('maps a minted invite onto the readiness shape', async () => {
    const rpc = server({
      available: true,
      pairingUrl: 'orca://pair?code=relay',
      inviteExpiresAt: 9
    })

    await expect(createServeRelayPairingOffer(rpc, args)).resolves.toEqual({
      ...direct,
      relay: { available: true, url: 'orca://pair?code=relay', inviteExpiresAt: 9 }
    })
  })
})
