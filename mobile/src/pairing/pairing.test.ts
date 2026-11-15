import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodePairingUrl, extractPairingCodeFromUrl, parsePairingCode } from './pairing'
import type { PairingOffer } from '../../../src/shared/remote-runtime/pairing/mobile-relay-pairing-offer'

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

  it('preserves legacy padding and aliases with the same decoded offer', () => {
    const paddedOffer = { ...offer, endpoint: `${offer.endpoint}/a` }
    const code = encodeOffer(paddedOffer)
    const alias = `${code.slice(0, -1)}${base64Alias(code.at(-1)!)}`

    expect(parsePairingCode(`${code}=`)).toEqual(paddedOffer)
    expect(parsePairingCode(alias)).toEqual(paddedOffer)
  })
})

function base64Alias(character: string): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  return alphabet[alphabet.indexOf(character) + 1]!
}
