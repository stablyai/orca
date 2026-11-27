import { describe, expect, it, vi } from 'vitest'
import { requestRuntimePairingOffer, type PairingOfferServer } from './pairing-offer-requests'

function fakeServer(pinnedNarrow: boolean) {
  const ensureNetworkExposure = vi.fn(async () => {
    if (pinnedNarrow) {
      throw new Error('Runtime bind address is pinned to 127.0.0.1; refusing to widen to all interfaces')
    }
  })
  const createPairingOffer = vi.fn(() => ({ available: true }) as never)
  const server = {
    getNetworkExposureBindHost: () => (pinnedNarrow ? '127.0.0.1' : '0.0.0.0'),
    isBindPinnedNarrow: () => pinnedNarrow,
    ensureNetworkExposure,
    createPairingOffer,
    createMobilePairingOffer: vi.fn()
  } as unknown as PairingOfferServer
  return { server, ensureNetworkExposure, createPairingOffer }
}

describe('pairing behind a proxy with a narrow pinned bind', () => {
  it('mints for an explicit address without widening the bind', async () => {
    const { server, ensureNetworkExposure, createPairingOffer } = fakeServer(true)
    const offer = await requestRuntimePairingOffer(server, { address: 'https://surface.example.ts.net' })
    expect(offer).toEqual({ available: true })
    expect(ensureNetworkExposure).not.toHaveBeenCalled()
    expect(createPairingOffer).toHaveBeenCalledWith(
      expect.objectContaining({ address: 'https://surface.example.ts.net', reach: 'network' })
    )
  })

  it('widens as before when the bind is not pinned', async () => {
    const { server, ensureNetworkExposure } = fakeServer(false)
    await requestRuntimePairingOffer(server, { address: '100.64.1.20' })
    expect(ensureNetworkExposure).toHaveBeenCalledOnce()
  })
})
