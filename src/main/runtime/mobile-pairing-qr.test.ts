import { describe, expect, it } from 'vitest'
import { PNG } from 'pngjs'
import { encodePairingOffer } from '../../shared/pairing'
import type { PairingOffer } from '../../shared/mobile-relay-pairing-offer'
import { encodeMobilePairingQr } from './mobile-pairing-qr'

// Keep every capacity probe in the same encoded payload family.
const FIXED_INVITE_EXPIRES_AT = Date.now() + 5 * 60_000

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
            inviteExpiresAt: FIXED_INVITE_EXPIRES_AT,
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
  it('renders the current Relay-sized symbol at two pixels per module with a four-module quiet zone', async () => {
    const { default: QRCode } = await import('qrcode')
    const url = pairingUrl(100, true)
    const moduleCount = QRCode.create(url, { errorCorrectionLevel: 'M' }).modules.size
    expect(moduleCount).toBe(101)

    const result = await encodeMobilePairingQr(url)
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }

    const image = PNG.sync.read(Buffer.from(result.qrDataUrl.split(',')[1]!, 'base64'))
    expect(result.qrSize).toBe(218)
    expect(image.width).toBe(result.qrSize)
    expect(image.height).toBe(result.qrSize)
    expect(image.data.subarray((8 * image.width + 7) * 4, (8 * image.width + 8) * 4)).toEqual(
      Buffer.from([255, 255, 255, 255])
    )
    expect(image.data.subarray((8 * image.width + 8) * 4, (8 * image.width + 9) * 4)).toEqual(
      Buffer.from([0, 0, 0, 255])
    )
  })

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
