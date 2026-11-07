import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodePairingUrl, extractPairingCodeFromUrl, parsePairingCode } from './pairing'
import type { PairingOffer } from '../../../src/shared/remote-runtime/pairing/mobile-relay-pairing-offer'
import { PAIRING_INPUT_MAX_CHARACTERS } from '../../../src/shared/remote-runtime/pairing/mobile-pairing-protocol-limits'

const offer: PairingOffer = {
  v: 2,
  endpoint: 'ws://100.102.47.57:6768',
  deviceToken: 'token-abc',
  publicKeyB64: 'pubkey-xyz'
}

function encodeOffer(input: PairingOffer = offer): string {
  return btoa(JSON.stringify(input)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('pairing deep links', () => {
  it('rejects lookalike routes', () => {
    expect(extractPairingCodeFromUrl('orca://pairing?code=abc123')).toBeNull()
    expect(extractPairingCodeFromUrl('orca://pair-extra?code=abc123')).toBeNull()
  })

  it('decodes desktop QR payloads when atob requires base64 padding', () => {
    const realAtob = globalThis.atob
    vi.stubGlobal('atob', (input: string) => {
      if (input.length % 4 !== 0) {
        throw new Error('Invalid base64 length')
      }
      return realAtob(input)
    })

    expect(decodePairingUrl(`orca://pair?code=${encodeOffer()}`)).toEqual(offer)
  })

  it('rejects oversized raw codes and URLs before parsing', () => {
    const code = encodeOffer()
    const oversizedRawCode = `${code}${' '.repeat(PAIRING_INPUT_MAX_CHARACTERS)}`
    const oversizedUrl = `orca://pair?code=${code}&ignored=${'A'.repeat(
      PAIRING_INPUT_MAX_CHARACTERS
    )}`

    expect(parsePairingCode(oversizedRawCode)).toBeNull()
    expect(extractPairingCodeFromUrl(oversizedUrl)).toBeNull()
    expect(decodePairingUrl(oversizedUrl)).toBeNull()
  })

  it('preserves legacy padding and aliases with the same decoded offer', () => {
    const paddedOffer = { ...offer, endpoint: `${offer.endpoint}/a` }
    const code = encodeOffer(paddedOffer)
    expect(code.length % 4).toBe(2)
    const alias = `${code.slice(0, -1)}${base64Alias(code.at(-1)!)}`

    expect(parsePairingCode(`${code}=`)).toEqual(paddedOffer)
    expect(parsePairingCode(`${code}==`)).toEqual(paddedOffer)
    expect(parsePairingCode(alias)).toEqual(paddedOffer)
  })

  it('preserves native iroh endpoint and dial hints from pairing offers', () => {
    const withIroh = {
      ...offer,
      iroh: {
        endpointId: 'a'.repeat(64),
        relayUrl: 'https://aps1-1.relay.n0.iroh.link./',
        directAddresses: ['192.168.1.9:41234', '[fe80::1%3]:41234', '[::ffff:192.0.2.1]:443']
      }
    }
    expect(parsePairingCode(encodeOffer(withIroh))).toEqual(withIroh)
  })

  it('rejects invalid iroh endpoint ids on pairing offers', () => {
    const bad = {
      ...offer,
      iroh: { endpointId: 'not-a-valid-id' }
    }
    expect(parsePairingCode(encodeOffer(bad))).toBeNull()
  })

  it.each([
    { relayUrl: 'not a URL' },
    { relayUrl: 'https://relay.example/path' },
    { directAddresses: ['old-hostname:443'] },
    { directAddresses: ['[:::1]:443'] }
  ])('rejects malformed iroh hints at QR import (%j)', (hints) => {
    const bad = { ...offer, iroh: { endpointId: 'a'.repeat(64), ...hints } }

    expect(parsePairingCode(encodeOffer(bad))).toBeNull()
  })
})

function base64Alias(character: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  return alphabet[alphabet.indexOf(character) + 1]!
}
