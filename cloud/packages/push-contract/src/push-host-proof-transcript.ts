const textEncoder = new TextEncoder()

export const PUSH_HOST_PROOF_TRANSCRIPT_DOMAIN = 'orca-push-host-proof/v1'
export const PUSH_HOST_CHALLENGE_PLAINTEXT_DOMAIN = 'orca-push-host-challenge/v1'
export const PUSH_HOST_CHALLENGE_BOX_ALGORITHM = 'Curve25519-XSalsa20-Poly1305'
export const PUSH_HOST_PROOF_ALGORITHM = 'HMAC-SHA-256'

export interface PushHostProofTranscriptInput {
  gatewayOrigin: string
  gatewayEphemeralPublicKey: Uint8Array
  challengeNonce: Uint8Array
  challengeId: string
  issuedAt: number
  expiresAt: number
  hostFingerprint: string
  hostPublicKey: Uint8Array
}

export const PUSH_HOST_PROOF_TRANSCRIPT_FIELD_COUNT = 10

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

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.byteLength
  }
  return output
}

function field(name: string, value: Uint8Array): Uint8Array {
  const encodedName = textEncoder.encode(name)
  return concat([uint32(encodedName.byteLength), encodedName, uint32(value.byteLength), value])
}

function text(value: string): Uint8Array {
  return textEncoder.encode(value)
}

function requireByteLength(value: Uint8Array, expected: number, name: string): void {
  if (value.byteLength !== expected) throw new Error(`${name} must be ${expected} bytes`)
}

export function buildPushHostProofTranscript(input: PushHostProofTranscriptInput): Uint8Array {
  requireByteLength(input.gatewayEphemeralPublicKey, 32, 'gatewayEphemeralPublicKey')
  requireByteLength(input.challengeNonce, 24, 'challengeNonce')
  requireByteLength(input.hostPublicKey, 32, 'hostPublicKey')
  return concat([
    field('protocol', text(PUSH_HOST_PROOF_TRANSCRIPT_DOMAIN)),
    field('version', new Uint8Array([1])),
    field('gatewayOrigin', text(input.gatewayOrigin)),
    field('gatewayEphemeralPublicKey', input.gatewayEphemeralPublicKey),
    field('challengeNonce', input.challengeNonce),
    field('challengeId', text(input.challengeId)),
    field('issuedAt', uint64(input.issuedAt)),
    field('expiresAt', uint64(input.expiresAt)),
    field('hostFingerprint', text(input.hostFingerprint)),
    field('hostPublicKey', input.hostPublicKey)
  ])
}

export function buildPushHostChallengePlaintext(
  transcript: Uint8Array,
  challengeSecret: Uint8Array
): Uint8Array {
  if (challengeSecret.byteLength !== 32) throw new Error('challengeSecret must be 32 bytes')
  // Why: the encrypted random secret makes the public transcript insufficient to forge the ack.
  return concat([
    text(`${PUSH_HOST_CHALLENGE_PLAINTEXT_DOMAIN}\0`),
    uint32(transcript.byteLength),
    transcript,
    challengeSecret
  ])
}

export function buildPushHostProofMacInput(transcript: Uint8Array): Uint8Array {
  return concat([text(`${PUSH_HOST_PROOF_TRANSCRIPT_DOMAIN}\0ack\0`), transcript])
}
