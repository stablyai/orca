import { describe, expect, it } from 'vitest'
import { encodePairingOffer, parsePairingCode, PAIRING_OFFER_VERSION } from '../../shared/pairing'
import type { ServeReadiness } from '../server/serve-readiness'
import { tunneledOrcadPairingCode } from './orcad-tunneled-pairing'

function readiness(endpoint = 'ws://[::1]:6768/runtime?mode=paired#fragment'): ServeReadiness {
  return {
    runtimeId: 'runtime-1',
    boundEndpoint: 'ws://127.0.0.1:6768',
    advertisedEndpoint: null,
    managedWslCliReconciliation: 'settled',
    pairing: {
      available: true,
      url: encodePairingOffer({
        v: PAIRING_OFFER_VERSION,
        endpoint,
        deviceToken: 'device-token',
        publicKeyB64: 'public-key',
        pairedDeviceId: 'device-1'
      }),
      endpoint,
      deviceId: 'device-1',
      webClientUrl: null,
      scope: 'runtime',
      qr: null
    }
  }
}

describe('tunneledOrcadPairingCode', () => {
  it('rewrites only the endpoint authority for the local tunnel', () => {
    const rewritten = parsePairingCode(tunneledOrcadPairingCode(readiness(), 46_768))

    expect(rewritten).toEqual({
      v: PAIRING_OFFER_VERSION,
      endpoint: 'ws://127.0.0.1:46768/runtime?mode=paired#fragment',
      deviceToken: 'device-token',
      publicKeyB64: 'public-key',
      pairedDeviceId: 'device-1'
    })
  })

  it('refuses a non-loopback offer', () => {
    expect(() => tunneledOrcadPairingCode(readiness('wss://runtime.example.com'), 46_768)).toThrow(
      'not loopback-only'
    )
  })
})
