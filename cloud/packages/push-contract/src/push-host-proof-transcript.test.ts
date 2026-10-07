import { describe, expect, it } from 'vitest'
import {
  buildPushHostChallengePlaintext,
  buildPushHostProofMacInput,
  buildPushHostProofTranscript,
  PUSH_HOST_CHALLENGE_PLAINTEXT_DOMAIN,
  PUSH_HOST_PROOF_TRANSCRIPT_DOMAIN,
  PUSH_HOST_PROOF_TRANSCRIPT_FIELD_COUNT
} from './push-host-proof-transcript.js'
import { PUSH_LIMITS } from './push-limits.js'

const transcriptInput = {
  gatewayOrigin: 'https://push.onorca.dev',
  gatewayEphemeralPublicKey: new Uint8Array(32).fill(7),
  challengeNonce: new Uint8Array(24).fill(9),
  challengeId: 'challenge-1',
  issuedAt: 1_700_000_000_000,
  expiresAt: 1_700_000_000_000 + PUSH_LIMITS.challengeTtlMs,
  hostFingerprint: 'abcdefghijklmnop',
  hostPublicKey: new Uint8Array(32).fill(4)
}

describe('push host proof transcript', () => {
  it('is deterministic and order dependent', () => {
    const first = buildPushHostProofTranscript(transcriptInput)
    const second = buildPushHostProofTranscript({ ...transcriptInput })
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true)
    const different = buildPushHostProofTranscript({
      ...transcriptInput,
      challengeId: 'challenge-2'
    })
    expect(Buffer.from(first).equals(Buffer.from(different))).toBe(false)
  })

  it('encodes exactly the ten specified fields in order', () => {
    const transcript = buildPushHostProofTranscript(transcriptInput)
    const view = new DataView(transcript.buffer, transcript.byteOffset, transcript.byteLength)
    const names: string[] = []
    let offset = 0
    while (offset < transcript.byteLength) {
      const nameLength = view.getUint32(offset, false)
      offset += 4
      names.push(Buffer.from(transcript.slice(offset, offset + nameLength)).toString('utf8'))
      offset += nameLength
      offset += 4 + view.getUint32(offset, false)
    }
    expect(names).toEqual([
      'protocol',
      'version',
      'gatewayOrigin',
      'gatewayEphemeralPublicKey',
      'challengeNonce',
      'challengeId',
      'issuedAt',
      'expiresAt',
      'hostFingerprint',
      'hostPublicKey'
    ])
    expect(names).toHaveLength(PUSH_HOST_PROOF_TRANSCRIPT_FIELD_COUNT)
    expect(offset).toBe(transcript.byteLength)
  })

  it('rejects mis-sized key material', () => {
    expect(() =>
      buildPushHostProofTranscript({
        ...transcriptInput,
        hostPublicKey: new Uint8Array(31)
      })
    ).toThrow('hostPublicKey must be 32 bytes')
    expect(() =>
      buildPushHostProofTranscript({ ...transcriptInput, challengeNonce: new Uint8Array(23) })
    ).toThrow('challengeNonce must be 24 bytes')
  })

  it('frames the challenge plaintext as domain, length, transcript, secret', () => {
    const transcript = buildPushHostProofTranscript(transcriptInput)
    const secret = new Uint8Array(32).fill(11)
    const plaintext = buildPushHostChallengePlaintext(transcript, secret)
    const domain = Buffer.from(`${PUSH_HOST_CHALLENGE_PLAINTEXT_DOMAIN}\0`, 'utf8')
    expect(Buffer.from(plaintext.slice(0, domain.byteLength)).equals(domain)).toBe(true)
    const declared = new DataView(
      plaintext.buffer,
      plaintext.byteOffset + domain.byteLength,
      4
    ).getUint32(0, false)
    expect(declared).toBe(transcript.byteLength)
    expect(plaintext.byteLength).toBe(domain.byteLength + 4 + transcript.byteLength + 32)
    expect(
      Buffer.from(plaintext.slice(plaintext.byteLength - 32)).equals(Buffer.from(secret))
    ).toBe(true)
    expect(() => buildPushHostChallengePlaintext(transcript, new Uint8Array(16))).toThrow(
      'challengeSecret must be 32 bytes'
    )
  })

  it('separates the ack mac input from the challenge domain', () => {
    const transcript = buildPushHostProofTranscript(transcriptInput)
    const macInput = buildPushHostProofMacInput(transcript)
    expect(Buffer.from(macInput).toString('utf8')).toContain(
      `${PUSH_HOST_PROOF_TRANSCRIPT_DOMAIN}\0ack\0`
    )
    expect(macInput.byteLength).toBe(
      Buffer.byteLength(`${PUSH_HOST_PROOF_TRANSCRIPT_DOMAIN}\0ack\0`) + transcript.byteLength
    )
  })
})
