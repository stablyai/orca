import { describe, expect, it, vi } from 'vitest'
import { requestRuntimePairingOffer, type PairingOfferServer } from './pairing-offer-requests'

const PINNED_LAN = '192.168.1.9'

function pairingServer(bindHost: string) {
  const ensureNetworkExposure = vi.fn(async () => {
    throw new Error(
      `Runtime bind address is pinned to ${bindHost}; refusing to widen to all interfaces`
    )
  })
  const createPairingOffer = vi.fn(() => ({
    available: true as const,
    pairingUrl: 'https://example.test/pair',
    endpoint: `ws://${PINNED_LAN}:6768`,
    deviceId: 'device-1',
    webClientUrl: null,
    offerExpiresAt: null
  }))
  const server: PairingOfferServer = {
    getNetworkExposureBindHost: () => bindHost,
    ensureNetworkExposure,
    createPairingOffer,
    createMobilePairingOffer: vi.fn()
  }
  return { server, ensureNetworkExposure, createPairingOffer }
}

describe('requestRuntimePairingOffer with a pinned bind', () => {
  it('mints a runtime offer for the pinned LAN address without widening', async () => {
    const { server, ensureNetworkExposure, createPairingOffer } = pairingServer(PINNED_LAN)

    const offer = await requestRuntimePairingOffer(server, { address: PINNED_LAN })

    expect(ensureNetworkExposure).not.toHaveBeenCalled()
    expect(createPairingOffer).toHaveBeenCalledWith(
      expect.objectContaining({ address: PINNED_LAN, scope: 'runtime', reach: 'network' })
    )
    expect(offer).toMatchObject({ available: true, deviceId: 'device-1' })
  })

  it('accepts the same pinned address when it is written as a WebSocket URL', async () => {
    const { server, ensureNetworkExposure, createPairingOffer } = pairingServer(PINNED_LAN)

    await requestRuntimePairingOffer(server, { address: `ws://${PINNED_LAN}:6768` })

    expect(ensureNetworkExposure).not.toHaveBeenCalled()
    expect(createPairingOffer).toHaveBeenCalledWith(
      expect.objectContaining({ address: `ws://${PINNED_LAN}:6768` })
    )
  })

  it('still refuses to widen when the requested address is not the pin', async () => {
    const { server, ensureNetworkExposure, createPairingOffer } = pairingServer(PINNED_LAN)

    const offer = await requestRuntimePairingOffer(server, { address: '10.1.2.3' })

    expect(ensureNetworkExposure).toHaveBeenCalledOnce()
    expect(createPairingOffer).not.toHaveBeenCalled()
    expect(offer).toMatchObject({ available: false, reason: 'network_exposure_failed' })
  })

  it('still refuses a loopback pin that cannot serve the requested LAN address', async () => {
    const { server, ensureNetworkExposure } = pairingServer('127.0.0.1')

    const offer = await requestRuntimePairingOffer(server, { address: PINNED_LAN })

    expect(ensureNetworkExposure).toHaveBeenCalledOnce()
    expect(offer).toMatchObject({ available: false, reason: 'network_exposure_failed' })
  })

  it('still widens an unpinned listener before advertising a LAN address', async () => {
    const { server, ensureNetworkExposure, createPairingOffer } = pairingServer('0.0.0.0')
    ensureNetworkExposure.mockResolvedValueOnce(undefined)

    await requestRuntimePairingOffer(server, { address: PINNED_LAN })

    expect(ensureNetworkExposure).toHaveBeenCalledOnce()
    expect(createPairingOffer).toHaveBeenCalledOnce()
  })

  it('does not widen a this-computer loopback offer', async () => {
    const { server, ensureNetworkExposure, createPairingOffer } = pairingServer('0.0.0.0')

    await requestRuntimePairingOffer(server, {
      address: '127.0.0.1',
      reach: 'this-computer'
    })

    expect(ensureNetworkExposure).not.toHaveBeenCalled()
    expect(createPairingOffer).toHaveBeenCalledWith(
      expect.objectContaining({ reach: 'this-computer' })
    )
  })
})
