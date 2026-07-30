import { describe, expect, it } from 'vitest'
import { encodePairingOffer } from '../../shared/pairing'
import type { PairingOffer } from '../../shared/mobile-relay-pairing-offer'
import { encodeMobilePairingQr } from './mobile-pairing-qr'

function pairingUrl(endpointLength: number, relay: boolean): string {
  const prefix = 'wss://pair.example/'
  const offer: PairingOffer = {
    v: 2,
    endpoint: `${prefix}${'a'.repeat(Math.max(0, endpointLength - prefix.length))}`,
    deviceToken: 'd'.repeat(43),
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
            inviteExpiresAt: Date.now() + 60_000,
            e2eeFraming: 2
          }
        }
      : {})
  }
  return encodePairingOffer(offer)
}

async function discoverEndpointBoundary(relay: boolean): Promise<number> {
  let passing = 1
  let failing = 4_000
  expect((await encodeMobilePairingQr(pairingUrl(passing, relay))).ok).toBe(true)
  expect((await encodeMobilePairingQr(pairingUrl(failing, relay))).ok).toBe(false)
  while (failing - passing > 1) {
    const candidate = Math.floor((passing + failing) / 2)
    if ((await encodeMobilePairingQr(pairingUrl(candidate, relay))).ok) {
      passing = candidate
    } else {
      failing = candidate
    }
  }
  return passing
}

describe('encodeMobilePairingQr', () => {
  it.each([
    ['direct', false],
    ['relay', true]
  ] as const)(
    'uses the real encoder at the adjacent %s-offer capacity boundary',
    async (_, relay) => {
      const boundary = await discoverEndpointBoundary(relay)

      await expect(encodeMobilePairingQr(pairingUrl(boundary, relay))).resolves.toMatchObject({
        ok: true
      })
      await expect(encodeMobilePairingQr(pairingUrl(boundary + 1, relay))).resolves.toEqual({
        ok: false,
        reason: 'encoding_failed'
      })
    }
  )
})
