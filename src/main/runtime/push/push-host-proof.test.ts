import { describe, expect, it } from 'vitest'
import nacl from 'tweetnacl'
import {
  buildPushChallengeFixture,
  createPushHostKeypair,
  type PushTranscriptInput
} from './push-host-challenge-fixtures'
import { answerPushHostChallenge, type PushHostProofContext } from './push-host-proof'

const GATEWAY_ORIGIN = 'https://push.onorca.dev'
const HOST_FINGERPRINT = 'abcdef0123456789'
const ISSUED_AT = 1_770_000_000_000

function fixture(
  overrides: {
    transcript?: Partial<PushTranscriptInput>
    challenge?: Partial<Parameters<typeof answerPushHostChallenge>[0]>
    context?: Partial<PushHostProofContext>
  } = {}
): {
  challenge: Parameters<typeof answerPushHostChallenge>[0]
  context: PushHostProofContext
  proof: string
} {
  const built = buildPushChallengeFixture({
    hostKeypair: createPushHostKeypair(),
    gatewayOrigin: GATEWAY_ORIGIN,
    hostFingerprint: HOST_FINGERPRINT,
    issuedAt: ISSUED_AT,
    transcript: overrides.transcript,
    challenge: overrides.challenge
  })
  return {
    challenge: built.challenge,
    context: { ...built.context, now: () => ISSUED_AT + 1_000, ...overrides.context },
    proof: built.proof
  }
}

describe('answerPushHostChallenge', () => {
  it('answers a well-formed challenge with the ack HMAC', () => {
    const { challenge, context, proof } = fixture()
    expect(answerPushHostChallenge(challenge, context)).toBe(proof)
  })

  it('tolerates clock skew inside the 30s allowance', () => {
    const { challenge, context, proof } = fixture({ context: { now: () => ISSUED_AT - 20_000 } })
    expect(answerPushHostChallenge(challenge, context)).toBe(proof)
  })

  it('refuses a challenge whose secret was sealed to another host', () => {
    const { challenge, context } = fixture()
    expect(
      answerPushHostChallenge(challenge, {
        ...context,
        hostSecretKey: nacl.box.keyPair().secretKey
      })
    ).toBeNull()
  })

  it.each([
    ['gatewayOrigin', { gatewayOrigin: 'https://push.evil.example' }],
    ['hostFingerprint', { hostFingerprint: 'ffffffffffffffff' }],
    ['challengeId', { challengeId: 'challenge-other' }],
    ['issuedAt', { issuedAt: ISSUED_AT + 120_000 }]
  ] as const)('refuses a transcript whose %s does not match the challenge', (_name, transcript) => {
    const invalid: string[] = []
    const { challenge, context } = fixture({
      transcript,
      context: { onInvalid: (reason) => invalid.push(reason) }
    })
    expect(answerPushHostChallenge(challenge, context)).toBeNull()
    expect(invalid.join(',')).toContain('transcript')
  })

  it('refuses a transcript that swaps in a different gateway ephemeral key', () => {
    const { challenge, context } = fixture({
      transcript: { gatewayKey: nacl.box.keyPair().publicKey }
    })
    expect(answerPushHostChallenge(challenge, context)).toBeNull()
  })

  it('refuses an expired challenge beyond the skew allowance', () => {
    const { challenge, context } = fixture({
      context: { now: () => ISSUED_AT + 10_000 + 30_001 }
    })
    expect(answerPushHostChallenge(challenge, context)).toBeNull()
  })

  it('refuses a challenge whose declared expiry disagrees with the transcript', () => {
    const { challenge, context } = fixture()
    expect(
      answerPushHostChallenge({ ...challenge, expiresAt: challenge.expiresAt + 1 }, context)
    ).toBeNull()
  })

  it('refuses a non-canonical base64 ephemeral key without opening the box', () => {
    const { challenge, context } = fixture()
    expect(
      answerPushHostChallenge(
        { ...challenge, gatewayEphemeralPublicKeyB64: 'not base64!' },
        context
      )
    ).toBeNull()
  })
})
