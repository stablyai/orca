import { createHmac, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import nacl from 'tweetnacl'
import {
  answerRelayHostChallenge,
  type RelayHostChallenge,
  type RelayHostProofContext
} from './relay-host-proof'

const encoder = new TextEncoder()
const HOST_PROOF_DOMAIN = 'orca-relay-host-proof/v1'
const CHALLENGE_DOMAIN = 'orca-relay-host-challenge/v1'
const CLOCK_SKEW_MS = 30_000

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.byteLength
  }
  return output
}

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value, false)
  return bytes
}

function uint64(value: number): Uint8Array {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false)
  return bytes
}

function field(name: string, value: Uint8Array): Uint8Array {
  const encodedName = encoder.encode(name)
  return concat([uint32(encodedName.byteLength), encodedName, uint32(value.byteLength), value])
}

function text(value: string): Uint8Array {
  return encoder.encode(value)
}

function buildTranscript(input: {
  origin: string
  relayKey: Uint8Array
  nonce: Uint8Array
  challengeId: string
  issuedAt: number
  expiresAt: number
  relayHostId: string
  hostKey: Uint8Array
  userId?: string
  profileId?: string
  organizationId?: string
  assignmentEpoch?: number
}): Uint8Array {
  return concat([
    field('protocol', text(HOST_PROOF_DOMAIN)),
    field('version', new Uint8Array([1])),
    field('relayOrigin', text(input.origin)),
    field('relayEphemeralPublicKey', input.relayKey),
    field('challengeNonce', input.nonce),
    field('challengeId', text(input.challengeId)),
    field('issuedAt', uint64(input.issuedAt)),
    field('expiresAt', uint64(input.expiresAt)),
    field('userId', text(input.userId ?? 'user-1')),
    field('profileId', text(input.profileId ?? 'profile-1')),
    field('organizationId', text(input.organizationId ?? 'org-1')),
    field('relayHostId', text(input.relayHostId)),
    field('hostPublicKey', input.hostKey),
    field('assignmentEpoch', uint64(input.assignmentEpoch ?? 3)),
    field('previousGeneration', new Uint8Array()),
    field('resumeRequested', new Uint8Array([0]))
  ])
}

function buildChallengeFixture(options: {
  issuedAt: number
  expiresAt: number
  localNow: number
}): {
  challenge: RelayHostChallenge
  context: RelayHostProofContext
  expectedProof: string
} {
  const hostKeys = nacl.box.keyPair()
  const relayKeys = nacl.box.keyPair()
  const nonce = randomBytes(24)
  const secret = randomBytes(32)
  const origin = 'https://c2.relay.onorca.dev'
  const relayHostId = 'host-abc123'
  const challengeId = 'challenge-skew'
  const transcript = buildTranscript({
    origin,
    relayKey: relayKeys.publicKey,
    nonce,
    challengeId,
    issuedAt: options.issuedAt,
    expiresAt: options.expiresAt,
    relayHostId,
    hostKey: hostKeys.publicKey
  })
  const plaintext = concat([
    text(`${CHALLENGE_DOMAIN}\0`),
    uint32(transcript.byteLength),
    transcript,
    secret
  ])
  const challenge: RelayHostChallenge = {
    challengeId,
    relayEphemeralPublicKeyB64: Buffer.from(relayKeys.publicKey).toString('base64'),
    nonceB64: nonce.toString('base64'),
    ciphertextB64: Buffer.from(
      nacl.box(plaintext, nonce, hostKeys.publicKey, relayKeys.secretKey)
    ).toString('base64'),
    expiresAt: options.expiresAt
  }
  const context: RelayHostProofContext = {
    relayOrigin: origin,
    userId: 'user-1',
    profileId: 'profile-1',
    organizationId: 'org-1',
    relayHostId,
    hostPublicKey: hostKeys.publicKey,
    hostSecretKey: hostKeys.secretKey,
    assignmentEpoch: 3,
    resumeRequested: false,
    now: () => options.localNow
  }
  const expectedProof = createHmac('sha256', secret)
    .update(text(`${HOST_PROOF_DOMAIN}\0ack\0`))
    .update(transcript)
    .digest('base64')
  return { challenge, context, expectedProof }
}

describe('answerRelayHostChallenge clock skew (#10401)', () => {
  it('accepts a challenge when local clock is a few seconds behind (issuedAt in the near future)', () => {
    const serverNow = 1_700_000_000_000
    const skewBehindMs = 4_400
    const localNow = serverNow - skewBehindMs
    const issuedAt = serverNow
    const expiresAt = issuedAt + 10_000
    const { challenge, context, expectedProof } = buildChallengeFixture({
      issuedAt,
      expiresAt,
      localNow
    })

    expect(answerRelayHostChallenge(challenge, context)).toBe(expectedProof)
  })

  it('accepts a challenge when local clock is a few seconds ahead of expiresAt', () => {
    const serverNow = 1_700_000_000_000
    const issuedAt = serverNow
    const expiresAt = issuedAt + 10_000
    const localNow = expiresAt + 4_400
    const { challenge, context, expectedProof } = buildChallengeFixture({
      issuedAt,
      expiresAt,
      localNow
    })

    expect(answerRelayHostChallenge(challenge, context)).toBe(expectedProof)
  })

  it('accepts challenges at the clock-skew boundaries', () => {
    const issuedAt = 1_700_000_000_000
    const expiresAt = issuedAt + 10_000
    for (const localNow of [issuedAt - CLOCK_SKEW_MS, expiresAt + CLOCK_SKEW_MS]) {
      const { challenge, context, expectedProof } = buildChallengeFixture({
        issuedAt,
        expiresAt,
        localNow
      })
      expect(answerRelayHostChallenge(challenge, context)).toBe(expectedProof)
    }
  })

  it('still rejects challenges outside the allowed skew window', () => {
    const serverNow = 1_700_000_000_000
    const issuedAt = serverNow
    const expiresAt = issuedAt + 10_000
    const localNowTooBehind = issuedAt - CLOCK_SKEW_MS - 1
    const behind = buildChallengeFixture({
      issuedAt,
      expiresAt,
      localNow: localNowTooBehind
    })
    expect(answerRelayHostChallenge(behind.challenge, behind.context)).toBeNull()

    const localNowTooAhead = expiresAt + CLOCK_SKEW_MS + 1
    const ahead = buildChallengeFixture({
      issuedAt,
      expiresAt,
      localNow: localNowTooAhead
    })
    expect(answerRelayHostChallenge(ahead.challenge, ahead.context)).toBeNull()
  })

  it('still rejects an oversized server challenge window', () => {
    const issuedAt = 1_700_000_000_000
    const expiresAt = issuedAt + 10_001
    const { challenge, context } = buildChallengeFixture({
      issuedAt,
      expiresAt,
      localNow: issuedAt
    })
    expect(answerRelayHostChallenge(challenge, context)).toBeNull()
  })

  it('rejects a challenge that expires before it is issued', () => {
    const issuedAt = 1_700_000_000_000
    const expiresAt = issuedAt - 1
    const { challenge, context } = buildChallengeFixture({
      issuedAt,
      expiresAt,
      localNow: issuedAt
    })
    expect(answerRelayHostChallenge(challenge, context)).toBeNull()
  })
})
