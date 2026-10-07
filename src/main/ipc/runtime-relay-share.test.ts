import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRelayPairing } from '../runtime/runtime-rpc/runtime-rpc-pairing-types'
import { createRuntimeRelayPairingUrl } from './runtime-relay-share'

const { getDefaultPairingAddress, readRelayAccountFailure } = vi.hoisted(() => ({
  getDefaultPairingAddress: vi.fn(),
  readRelayAccountFailure: vi.fn()
}))

vi.mock('../runtime/pairing-network-interfaces', () => ({ getDefaultPairingAddress }))
vi.mock('../startup/serve-relay-pairing', () => ({ readRelayAccountFailure }))

const minted: RuntimeRelayPairing = {
  available: true,
  pairingUrl: 'orca://pair?code=relay',
  inviteExpiresAt: 9_000
}

function server(relay: RuntimeRelayPairing = minted) {
  return {
    ensureNetworkExposure: vi.fn(async () => {}),
    createRuntimeRelayPairingOffer: vi.fn(async () => ({
      available: true as const,
      pairingUrl: 'orca://pair?code=direct',
      endpoint: 'ws://192.168.1.10:6768',
      deviceId: 'runtime-1',
      webClientUrl: null,
      relay
    })),
    revokeRuntimeAccess: vi.fn(() => true)
  }
}

const lookup = async (): Promise<null> => null

describe('createRuntimeRelayPairingUrl', () => {
  beforeEach(() => {
    readRelayAccountFailure.mockResolvedValue(null)
    getDefaultPairingAddress.mockResolvedValue('192.168.1.10')
  })

  it('returns the Relay link of a fresh grant that also names the LAN address', async () => {
    const rpc = server()

    await expect(createRuntimeRelayPairingUrl(rpc, lookup)).resolves.toEqual({
      available: true,
      pairingUrl: 'orca://pair?code=relay',
      inviteExpiresAt: 9_000,
      deviceId: 'runtime-1'
    })
    expect(rpc.ensureNetworkExposure).toHaveBeenCalledOnce()
    expect(rpc.createRuntimeRelayPairingOffer).toHaveBeenCalledWith(
      expect.objectContaining({ address: '192.168.1.10', reach: 'network', rotate: true })
    )
  })

  it('shares through Relay alone without widening the listener when no LAN address exists', async () => {
    getDefaultPairingAddress.mockResolvedValue(null)
    const rpc = server()

    await expect(createRuntimeRelayPairingUrl(rpc, lookup)).resolves.toMatchObject({
      available: true
    })
    expect(rpc.ensureNetworkExposure).not.toHaveBeenCalled()
    expect(rpc.createRuntimeRelayPairingOffer).toHaveBeenCalledWith(
      expect.objectContaining({ address: '127.0.0.1', reach: 'this-computer' })
    )
  })

  it('names the missing account step before creating any grant', async () => {
    readRelayAccountFailure.mockResolvedValue({
      available: false,
      code: 'relay_sign_in_required',
      guidance: 'Sign in.'
    })
    const rpc = server()

    await expect(createRuntimeRelayPairingUrl(rpc, lookup)).resolves.toEqual({
      available: false,
      reason: 'relay_sign_in_required',
      guidance: 'Sign in.'
    })
    expect(rpc.createRuntimeRelayPairingOffer).not.toHaveBeenCalled()
    expect(rpc.ensureNetworkExposure).not.toHaveBeenCalled()
  })

  it('revokes the grant instead of handing out a LAN-only link when the invite fails', async () => {
    const rpc = server({
      available: false,
      failure: { code: 'relay_control_not_active', stage: 'create_pairing_relay', message: 'x' }
    })

    await expect(createRuntimeRelayPairingUrl(rpc, lookup)).resolves.toMatchObject({
      available: false,
      reason: 'relay_control_not_active'
    })
    expect(rpc.revokeRuntimeAccess).toHaveBeenCalledWith('runtime-1')
  })

  it('reports a failed listener widen without minting', async () => {
    const rpc = server()
    rpc.ensureNetworkExposure.mockRejectedValue(new Error('EADDRINUSE'))
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(createRuntimeRelayPairingUrl(rpc, lookup)).resolves.toMatchObject({
      available: false,
      reason: 'network_exposure_failed'
    })
    expect(rpc.createRuntimeRelayPairingOffer).not.toHaveBeenCalled()
  })
})
