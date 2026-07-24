import { describe, expect, it, vi } from 'vitest'
import nacl from 'tweetnacl'
import {
  answerRelayHostChallenge,
  RELAY_HOST_CHALLENGE_MAX_CIPHERTEXT_BASE64_CHARACTERS
} from './relay-host-proof'

describe('relay host proof base64 admission', () => {
  it('rejects oversized fixed-width fields before decoding', () => {
    const decode = vi.spyOn(Buffer, 'from')

    expect(
      answerRelayHostChallenge(
        {
          challengeId: 'challenge',
          relayEphemeralPublicKeyB64: 'A'.repeat(45),
          nonceB64: 'A'.repeat(33),
          ciphertextB64: 'AAAA',
          expiresAt: Date.now() + 1_000
        },
        context()
      )
    ).toBeNull()
    expect(decode).not.toHaveBeenCalled()
    decode.mockRestore()
  })

  it('rejects oversized ciphertext before decoding that field', () => {
    const relayKey = Buffer.from(new Uint8Array(32)).toString('base64')
    const nonce = Buffer.from(new Uint8Array(24)).toString('base64')
    const decode = vi.spyOn(Buffer, 'from')

    expect(
      answerRelayHostChallenge(
        {
          challengeId: 'challenge',
          relayEphemeralPublicKeyB64: relayKey,
          nonceB64: nonce,
          ciphertextB64: 'A'.repeat(RELAY_HOST_CHALLENGE_MAX_CIPHERTEXT_BASE64_CHARACTERS + 1),
          expiresAt: Date.now() + 1_000
        },
        context()
      )
    ).toBeNull()
    expect(decode).toHaveBeenCalledTimes(2)
    decode.mockRestore()
  })
})

function context() {
  const host = nacl.box.keyPair()
  return {
    relayOrigin: 'https://relay.example',
    userId: 'user',
    profileId: 'profile',
    organizationId: 'organization',
    relayHostId: 'host',
    hostPublicKey: host.publicKey,
    hostSecretKey: host.secretKey,
    assignmentEpoch: 1,
    resumeRequested: false
  }
}
