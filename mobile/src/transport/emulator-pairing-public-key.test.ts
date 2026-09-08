import { describe, expect, it } from 'vitest'
import {
  pairingEndpointPortFromUrl,
  pairingPublicKeyFromUrl
} from '../../scripts/emulator-pairing-public-key.mjs'

function pairingUrl(offer: unknown): string {
  const code = Buffer.from(JSON.stringify(offer)).toString('base64url')
  return `orca://pair?code=${code}`
}

describe('emulator pairing public key extraction', () => {
  it('extracts only the public identity used for deterministic E2E host selection', () => {
    expect(pairingPublicKeyFromUrl(pairingUrl({ publicKeyB64: 'paired-key' }))).toBe('paired-key')
  })

  it('extracts the endpoint port used for a same-address E2E restart', () => {
    expect(pairingEndpointPortFromUrl(pairingUrl({ endpoint: '192.168.1.4:7331' }))).toBe(7331)
    expect(pairingEndpointPortFromUrl(pairingUrl({ endpoint: 'wss://orca.example:8443' }))).toBe(
      8443
    )
  })

  it('rejects missing URLs, codes, and public keys', () => {
    expect(() => pairingPublicKeyFromUrl()).toThrow('requires a pairing URL')
    expect(() => pairingPublicKeyFromUrl('orca://pair')).toThrow('invalid pairing URL')
    expect(() => pairingPublicKeyFromUrl(pairingUrl({ deviceToken: 'secret' }))).toThrow(
      'invalid public key'
    )
  })
})
