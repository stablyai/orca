import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  decodePairingUrl,
  extractPairingCodeFromUrl,
  getInitialPairingCode,
  parsePairingCode
} from './pairing'
import type { PairingOffer } from './types'


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
  it('extracts the QR pairing code from the hash payload', () => {
    expect(extractPairingCodeFromUrl('orca://pair#abc123')).toBe('abc123')
  })

  it('extracts the pairing code from a query param', () => {
    expect(extractPairingCodeFromUrl('orca://pair?code=abc123')).toBe('abc123')
  })

  it('accepts scanner casing and surrounding whitespace', () => {
    expect(extractPairingCodeFromUrl('  ORCA://PAIR?code=abc123\n')).toBe('abc123')
  })

  it('rejects lookalike routes', () => {
    expect(extractPairingCodeFromUrl('orca://pairing?code=abc123')).toBeNull()
    expect(extractPairingCodeFromUrl('orca://pair-extra?code=abc123')).toBeNull()
  })

  it('prefers the query pairing code when both query and hash are present', () => {
    expect(extractPairingCodeFromUrl('orca://pair?code=query-code#hash-code')).toBe('query-code')
  })

  it('reads cold hash links from the scene-aware URL registry', async () => {
    const getInitialURL = vi.fn(async () => null)

    expect(
      await getInitialPairingCode({
        getLinkingURL: () => 'orca://pair#scene-code',
        getInitialURL
      })
    ).toBe('scene-code')
    expect(getInitialURL).not.toHaveBeenCalled()
  })

  it('falls back to the legacy initial URL when the scene registry is empty', async () => {
    expect(
      await getInitialPairingCode({
        getLinkingURL: () => null,
        getInitialURL: async () => 'orca://pair?code=legacy-code'
      })
    ).toBe('legacy-code')
  })

  it('falls back when getLinkingURL throws', async () => {
    const getInitialURL = vi.fn(async () => 'orca://pair?code=legacy-after-throw')

    expect(
      await getInitialPairingCode({
        getLinkingURL: () => {
          throw new Error('linking registry unavailable')
        },
        getInitialURL
      })
    ).toBe('legacy-after-throw')
    expect(getInitialURL).toHaveBeenCalledTimes(1)
  })

  it('ignores empty and unrelated URLs', () => {
    expect(extractPairingCodeFromUrl('orca://pair')).toBeNull()
    expect(extractPairingCodeFromUrl('https://example.com/pair#abc123')).toBeNull()
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

  it('parses a full pairing URL and a bare copied code', () => {
    const code = encodeOffer()

    expect(parsePairingCode(`orca://pair?code=${code}`)).toEqual(offer)
    expect(parsePairingCode(code)).toEqual(offer)
  })

  it('preserves a TLS reverse-proxy endpoint with an explicit port and path', () => {
    const proxiedOffer = {
      ...offer,
      endpoint: 'wss://proxy.example:443/orca/runtime'
    }
    const code = encodeOffer(proxiedOffer)

    expect(parsePairingCode(code)).toEqual(proxiedOffer)
  })
})
