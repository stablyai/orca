import type { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildServePairingReadiness } from './serve-pairing-readiness'

vi.mock('./serve-pairing-output', () => ({
  renderServePairingQr: vi.fn(async () => 'terminal QR'),
  assertServeProjectRoot: vi.fn()
}))

function server() {
  const direct = {
    available: true as const,
    pairingUrl: 'orca://pair?direct',
    endpoint: 'ws://127.0.0.1:6768',
    deviceId: 'phone',
    webClientUrl: null,
    connectionMode: 'automatic' as const
  }
  return {
    getWebSocketEndpoint: () => 'ws://0.0.0.0:6768',
    createPairingOffer: vi.fn<OrcaRuntimeRpcServer['createPairingOffer']>(() => direct),
    createMobilePairingOffer: vi.fn<OrcaRuntimeRpcServer['createMobilePairingOffer']>(async () => ({
      ...direct,
      pairingUrl: 'orca://pair?relay=invite'
    }))
  }
}

describe('serve mobile pairing output', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('prints a Relay offer and QR when the host runs Relay', async () => {
    const rpc = server()
    const ready = await buildServePairingReadiness(
      { mobilePairing: true, pairingAddress: '192.168.10.50' },
      rpc,
      rpc
    )
    expect(rpc.createMobilePairingOffer).toHaveBeenCalledWith(
      expect.objectContaining({ address: '192.168.10.50', connectionMode: 'automatic' })
    )
    expect(rpc.createPairingOffer).not.toHaveBeenCalled()
    expect(ready.pairing).toMatchObject({
      available: true,
      url: 'orca://pair?relay=invite',
      qr: 'terminal QR',
      scope: 'mobile'
    })
  })

  it('falls back to the direct mobile link when Relay cannot mint an invite', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const rpc = server()
    rpc.createMobilePairingOffer.mockResolvedValueOnce({
      available: false,
      reason: 'relay_mint_failed',
      guidance: 'Sign in on this host.',
      relayFailure: {
        code: 'relay_provider_unavailable',
        stage: 'provider_missing',
        message: 'Orca Relay is not available on this desktop'
      }
    })
    const ready = await buildServePairingReadiness({ mobilePairing: true }, rpc, rpc)
    expect(rpc.createPairingOffer).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'mobile' })
    )
    expect(ready.pairing).toMatchObject({ available: true, url: 'orca://pair?direct' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('relay_provider_unavailable'))
  })

  it('reports other mobile offer failures instead of masking them', async () => {
    const rpc = server()
    rpc.createMobilePairingOffer.mockResolvedValueOnce({
      available: false,
      reason: 'device_registry_unavailable',
      guidance: 'Check disk.'
    })
    const ready = await buildServePairingReadiness({ mobilePairing: true }, rpc, rpc)
    expect(ready.pairing).toMatchObject({ available: false, reason: 'device_registry_unavailable' })
    expect(rpc.createPairingOffer).not.toHaveBeenCalled()
  })

  it('keeps the direct mobile offer on a host without Relay (orcad)', async () => {
    const rpc = server()
    const ready = await buildServePairingReadiness({ mobilePairing: true }, rpc)
    expect(rpc.createMobilePairingOffer).not.toHaveBeenCalled()
    expect(rpc.createPairingOffer).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'mobile' })
    )
    expect(ready.pairing).toMatchObject({ available: true, url: 'orca://pair?direct' })
  })
})
