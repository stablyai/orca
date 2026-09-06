// Test fixtures: builds the sealed challenge the push gateway would issue, so the
// proof answerer and the gateway client can both be exercised against a real box.
import { createHmac, randomBytes } from 'node:crypto'
import nacl from 'tweetnacl'
import type { E2EEKeypair } from '../e2ee-keypair'
import type { PushHostChallenge, PushHostProofContext } from './push-host-proof'

const encoder = new TextEncoder()
export const PUSH_PROOF_DOMAIN = 'orca-push-host-proof/v1'
export const PUSH_CHALLENGE_DOMAIN = 'orca-push-host-challenge/v1'

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

export function text(value: string): Uint8Array {
  return encoder.encode(value)
}

export type PushTranscriptInput = {
  gatewayOrigin: string
  gatewayKey: Uint8Array
  nonce: Uint8Array
  challengeId: string
  issuedAt: number
  expiresAt: number
  hostFingerprint: string
  hostKey: Uint8Array
}

export function buildPushTranscript(input: PushTranscriptInput): Uint8Array {
  return concat([
    field('protocol', text(PUSH_PROOF_DOMAIN)),
    field('version', new Uint8Array([1])),
    field('gatewayOrigin', text(input.gatewayOrigin)),
    field('gatewayEphemeralPublicKey', input.gatewayKey),
    field('challengeNonce', input.nonce),
    field('challengeId', text(input.challengeId)),
    field('issuedAt', uint64(input.issuedAt)),
    field('expiresAt', uint64(input.expiresAt)),
    field('hostFingerprint', text(input.hostFingerprint)),
    field('hostPublicKey', input.hostKey)
  ])
}

export function pushAckProof(secret: Uint8Array, transcript: Uint8Array): string {
  return createHmac('sha256', secret)
    .update(text(`${PUSH_PROOF_DOMAIN}\0ack\0`))
    .update(transcript)
    .digest('base64')
}

export function createPushHostKeypair(): E2EEKeypair {
  const keys = nacl.box.keyPair()
  return {
    publicKey: keys.publicKey,
    secretKey: keys.secretKey,
    publicKeyB64: Buffer.from(keys.publicKey).toString('base64')
  }
}

/** Seals a challenge for `hostPublicKey`; overrides let a suite corrupt one field at a time. */
export function buildPushChallengeFixture(input: {
  hostKeypair: E2EEKeypair
  gatewayOrigin: string
  hostFingerprint: string
  issuedAt: number
  challengeId?: string
  transcript?: Partial<PushTranscriptInput>
  challenge?: Partial<PushHostChallenge>
}): { challenge: PushHostChallenge; context: Omit<PushHostProofContext, 'now'>; proof: string } {
  const gatewayKeys = nacl.box.keyPair()
  const nonce = randomBytes(24)
  const secret = randomBytes(32)
  const expiresAt = input.issuedAt + 10_000
  const challengeId = input.challengeId ?? 'challenge-1'
  const transcript = buildPushTranscript({
    gatewayOrigin: input.gatewayOrigin,
    gatewayKey: gatewayKeys.publicKey,
    nonce,
    challengeId,
    issuedAt: input.issuedAt,
    expiresAt,
    hostFingerprint: input.hostFingerprint,
    hostKey: input.hostKeypair.publicKey,
    ...input.transcript
  })
  const plaintext = concat([
    text(`${PUSH_CHALLENGE_DOMAIN}\0`),
    uint32(transcript.byteLength),
    transcript,
    secret
  ])
  return {
    challenge: {
      challengeId,
      gatewayEphemeralPublicKeyB64: Buffer.from(gatewayKeys.publicKey).toString('base64'),
      nonceB64: nonce.toString('base64'),
      ciphertextB64: Buffer.from(
        nacl.box(plaintext, nonce, input.hostKeypair.publicKey, gatewayKeys.secretKey)
      ).toString('base64'),
      expiresAt,
      ...input.challenge
    },
    context: {
      gatewayOrigin: input.gatewayOrigin,
      hostFingerprint: input.hostFingerprint,
      hostPublicKey: input.hostKeypair.publicKey,
      hostSecretKey: input.hostKeypair.secretKey
    },
    proof: pushAckProof(secret, transcript)
  }
}
