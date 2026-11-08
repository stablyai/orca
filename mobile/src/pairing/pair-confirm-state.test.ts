import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'

import { resolvePairConfirmRouteState } from './pair-confirm-state'
import type { PairingOffer } from '../../../src/shared/remote-runtime/pairing/mobile-relay-pairing-offer'

function encodeOffer(offer: PairingOffer): string {
  return Buffer.from(JSON.stringify(offer))
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

describe('resolvePairConfirmRouteState', () => {
  const offer: PairingOffer = {
    v: 2,
    endpoint: 'ws://192.168.1.10:6768',
    deviceToken: 'token-abc',
    publicKeyB64: 'pubkey-xyz'
  }

  it('accepts a valid pairing code', () => {
    expect(resolvePairConfirmRouteState(encodeOffer(offer))).toEqual({
      kind: 'ready',
      offer,
      errorMessage: ''
    })
  })

  it('accepts a full pairing URL', () => {
    expect(resolvePairConfirmRouteState(`orca://pair#${encodeOffer(offer)}`)).toEqual({
      kind: 'ready',
      offer,
      errorMessage: ''
    })
    expect(resolvePairConfirmRouteState(`orca://pair?code=${encodeOffer(offer)}`)).toEqual({
      kind: 'ready',
      offer,
      errorMessage: ''
    })
  })
})
