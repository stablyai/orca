import { describe, expect, it } from 'vitest'
import {
  encodeMobileE2EEV2Transcript,
  validateMobileE2EEV2Handshake
} from '../../../shared/mobile-e2ee-v2-contract'
import {
  createMobileE2EEV2Fixture,
  MOBILE_E2EE_V2_VECTOR
} from '../../../shared/mobile-e2ee-v2-fixtures'
import { deriveMobileE2EEV2KeySchedule } from './mobile-e2ee-v2-key-schedule'

describe('desktop mobile E2EE v2 key schedule', () => {
  it('derives the normative 96-byte HKDF vector', () => {
    const { hello, ready, sharedSecret } = createMobileE2EEV2Fixture()
    const handshake = validateMobileE2EEV2Handshake(hello, ready)!
    const schedule = deriveMobileE2EEV2KeySchedule({
      sharedSecret,
      transcript: encodeMobileE2EEV2Transcript(handshake),
      clientNonce: handshake.clientNonce,
      desktopNonce: handshake.desktopNonce
    })

    expect(Buffer.from(schedule.mobileToDesktopKey).toString('hex')).toBe(
      MOBILE_E2EE_V2_VECTOR.mobileToDesktopKeyHex
    )
    expect(Buffer.from(schedule.desktopToMobileKey).toString('hex')).toBe(
      MOBILE_E2EE_V2_VECTOR.desktopToMobileKeyHex
    )
    expect(Buffer.from(schedule.sessionId).toString('hex')).toBe(MOBILE_E2EE_V2_VECTOR.sessionIdHex)
    expect(Buffer.from(schedule.transcriptHash).toString('hex')).toBe(
      MOBILE_E2EE_V2_VECTOR.transcriptHashHex
    )
  })

  it('derives unique direction keys and session IDs across fresh desktop nonces', () => {
    const { hello, ready, sharedSecret } = createMobileE2EEV2Fixture()
    const fingerprints = new Set<string>()
    for (let index = 0; index < 128; index++) {
      const nonce = Buffer.alloc(32)
      nonce.writeUInt32BE(index, 28)
      const handshake = validateMobileE2EEV2Handshake(hello, {
        ...ready,
        desktopNonceB64: nonce.toString('base64')
      })!
      const schedule = deriveMobileE2EEV2KeySchedule({
        sharedSecret,
        transcript: encodeMobileE2EEV2Transcript(handshake),
        clientNonce: handshake.clientNonce,
        desktopNonce: handshake.desktopNonce
      })
      fingerprints.add(
        [schedule.mobileToDesktopKey, schedule.desktopToMobileKey, schedule.sessionId]
          .map((bytes) => Buffer.from(bytes).toString('hex'))
          .join(':')
      )
    }
    expect(fingerprints.size).toBe(128)
  })
})
