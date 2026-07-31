import { describe, expect, it } from 'vitest'
import { encodePairingOffer } from '../../shared/pairing'
import {
  MAX_PAIRING_OFFER_JSON_BYTES,
  type PairingOffer
} from '../../shared/mobile-relay-pairing-offer'
import { encodeMobilePairingQr } from './mobile-pairing-qr'

// Keep every capacity probe in the same encoded payload family.
const FIXED_INVITE_EXPIRES_AT = Date.now() + 5 * 60_000

function largestPairingUrl(relay: boolean): string {
  const offer: PairingOffer = {
    v: 2,
    endpoint: 'wss://pair.example/runtime',
    deviceToken: 'd',
    publicKeyB64: Buffer.alloc(32, 7).toString('base64'),
    scope: 'mobile',
    ...(relay
      ? {
          relay: {
            v: 1,
            directorUrl: 'https://director.example',
            cellUrl: 'https://cell.example',
            assignmentEpoch: 1,
            relayHostId: 'a'.repeat(16),
            inviteToken: 'b'.repeat(43),
            inviteExpiresAt: FIXED_INVITE_EXPIRES_AT,
            e2eeFraming: 2
          }
        }
      : {})
  }
  let pairingUrl = encodePairingOffer(offer)
  for (let length = 2; length <= MAX_PAIRING_OFFER_JSON_BYTES; length += 1) {
    try {
      pairingUrl = encodePairingOffer({ ...offer, deviceToken: 'd'.repeat(length) })
    } catch {
      break
    }
  }
  return pairingUrl
}

describe('encodeMobilePairingQr', () => {
  it.each([
    ['direct', false],
    ['relay', true]
  ] as const)('encodes the largest schema-valid %s offer', async (_, relay) => {
    await expect(encodeMobilePairingQr(largestPairingUrl(relay))).resolves.toMatchObject({
      ok: true
    })
  })

  it('rejects a payload above the real encoder capacity', async () => {
    await expect(encodeMobilePairingQr(`orca://pair?code=${'a'.repeat(10_000)}`)).resolves.toEqual({
      ok: false,
      reason: 'encoding_failed'
    })
  })
})
