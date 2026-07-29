import { describe, expect, it } from 'vitest'
import {
  encodeMobileE2EEV2Transcript,
  validateMobileE2EEV2Handshake
} from '../../../src/shared/mobile-e2ee-v2-contract'
import {
  createMobileE2EEV2Fixture,
  MOBILE_E2EE_V2_VECTOR
} from '../../../src/shared/mobile-e2ee-v2-fixtures'
import { deriveMobileE2EEV2KeySchedule } from './mobile-e2ee-v2-key-schedule'

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

describe('mobile E2EE v2 key schedule', () => {
  it('matches the desktop normative HKDF vector', () => {
    const { hello, ready, sharedSecret } = createMobileE2EEV2Fixture()
    const handshake = validateMobileE2EEV2Handshake(hello, ready)!
    const schedule = deriveMobileE2EEV2KeySchedule({
      sharedSecret,
      transcript: encodeMobileE2EEV2Transcript(handshake),
      clientNonce: handshake.clientNonce,
      desktopNonce: handshake.desktopNonce
    })

    expect(hex(schedule.mobileToDesktopKey)).toBe(MOBILE_E2EE_V2_VECTOR.mobileToDesktopKeyHex)
    expect(hex(schedule.desktopToMobileKey)).toBe(MOBILE_E2EE_V2_VECTOR.desktopToMobileKeyHex)
    expect(hex(schedule.sessionId)).toBe(MOBILE_E2EE_V2_VECTOR.sessionIdHex)
    expect(hex(schedule.transcriptHash)).toBe(MOBILE_E2EE_V2_VECTOR.transcriptHashHex)
  })

  it('derives unique direction keys and session IDs across fresh client nonces', () => {
    const { hello, ready, sharedSecret } = createMobileE2EEV2Fixture()
    const fingerprints = new Set<string>()
    for (let index = 0; index < 128; index++) {
      const nonce = new Uint8Array(32)
      new DataView(nonce.buffer).setUint32(28, index, false)
      const clientNonceB64 = Buffer.from(nonce).toString('base64')
      const handshake = validateMobileE2EEV2Handshake(
        { ...hello, clientNonceB64 },
        { ...ready, clientNonceB64 }
      )!
      const schedule = deriveMobileE2EEV2KeySchedule({
        sharedSecret,
        transcript: encodeMobileE2EEV2Transcript(handshake),
        clientNonce: handshake.clientNonce,
        desktopNonce: handshake.desktopNonce
      })
      fingerprints.add(
        [schedule.mobileToDesktopKey, schedule.desktopToMobileKey, schedule.sessionId]
          .map(hex)
          .join(':')
      )
    }
    expect(fingerprints.size).toBe(128)
  })
})
