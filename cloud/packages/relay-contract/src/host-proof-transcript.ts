const textEncoder = new TextEncoder()

export const HOST_PROOF_TRANSCRIPT_DOMAIN = 'orca-relay-host-proof/v1'
export const HOST_CHALLENGE_PLAINTEXT_DOMAIN = 'orca-relay-host-challenge/v1'
export const HOST_CHALLENGE_BOX_ALGORITHM = 'Curve25519-XSalsa20-Poly1305'
export const HOST_PROOF_ALGORITHM = 'HMAC-SHA-256'

export interface HostProofTranscriptInput {
  relayOrigin: string
  relayEphemeralPublicKey: Uint8Array
  challengeNonce: Uint8Array
  challengeId: string
  issuedAt: number
  expiresAt: number
  userId: string
  profileId: string
  organizationId: string
  relayHostId: string
  hostPublicKey: Uint8Array
  assignmentEpoch: number
  previousGeneration?: number
  resumeRequested: boolean
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

export function buildHostProofTranscript(input: HostProofTranscriptInput): Uint8Array {
  requireByteLength(input.relayEphemeralPublicKey, 32, 'relayEphemeralPublicKey')
  requireByteLength(input.challengeNonce, 24, 'challengeNonce')
  requireByteLength(input.hostPublicKey, 32, 'hostPublicKey')
  return concat([
    field('protocol', text(HOST_PROOF_TRANSCRIPT_DOMAIN)),
    field('version', new Uint8Array([1])),
    field('relayOrigin', text(input.relayOrigin)),
    field('relayEphemeralPublicKey', input.relayEphemeralPublicKey),
    field('challengeNonce', input.challengeNonce),
    field('challengeId', text(input.challengeId)),
    field('issuedAt', uint64(input.issuedAt)),
    field('expiresAt', uint64(input.expiresAt)),
    field('userId', text(input.userId)),
    field('profileId', text(input.profileId)),
    field('organizationId', text(input.organizationId)),
    field('relayHostId', text(input.relayHostId)),
    field('hostPublicKey', input.hostPublicKey),
    field('assignmentEpoch', uint64(input.assignmentEpoch)),
    field(
      'previousGeneration',
      input.previousGeneration === undefined ? new Uint8Array() : uint64(input.previousGeneration)
    ),
    field('resumeRequested', new Uint8Array([input.resumeRequested ? 1 : 0]))
  ])
}

export function buildHostChallengePlaintext(
  transcript: Uint8Array,
  challengeSecret: Uint8Array
): Uint8Array {
  if (challengeSecret.byteLength !== 32) throw new Error('challengeSecret must be 32 bytes')
  // Why: the encrypted random secret makes the public transcript insufficient to forge the ack.
  return concat([
    text(`${HOST_CHALLENGE_PLAINTEXT_DOMAIN}\0`),
    uint32(transcript.byteLength),
    transcript,
    challengeSecret
  ])
}

export function buildHostProofMacInput(transcript: Uint8Array): Uint8Array {
  return concat([text(`${HOST_PROOF_TRANSCRIPT_DOMAIN}\0ack\0`), transcript])
}
