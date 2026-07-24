import { createHmac, timingSafeEqual } from 'node:crypto'
import nacl from 'tweetnacl'

const HOST_PROOF_TRANSCRIPT_DOMAIN = 'orca-relay-host-proof/v1'
const HOST_CHALLENGE_PLAINTEXT_DOMAIN = 'orca-relay-host-challenge/v1'
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export type RelayHostChallenge = {
  challengeId: string
  relayEphemeralPublicKeyB64: string
  nonceB64: string
  ciphertextB64: string
  expiresAt: number
}

export type RelayHostProofContext = {
  relayOrigin: string
  userId: string
  profileId: string
  organizationId: string
  relayHostId: string
  hostPublicKey: Uint8Array
  hostSecretKey: Uint8Array
  assignmentEpoch: number
  previousGeneration?: number
  resumeRequested: boolean
  now?: () => number
}

function decodeCanonicalBase64(value: string, expectedBytes: number): Uint8Array | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return null
  }
  const decoded = Buffer.from(value, 'base64')
  return decoded.byteLength === expectedBytes && decoded.toString('base64') === value
    ? decoded
    : null
}

function uint64(value: number): Uint8Array {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false)
  return bytes
}

function equal(left: Uint8Array | undefined, right: Uint8Array): boolean {
  return Boolean(left && left.byteLength === right.byteLength && timingSafeEqual(left, right))
}

function parseTranscript(transcript: Uint8Array): Map<string, Uint8Array> | null {
  const fields = new Map<string, Uint8Array>()
  const view = new DataView(transcript.buffer, transcript.byteOffset, transcript.byteLength)
  let offset = 0
  try {
    while (offset < transcript.byteLength) {
      const nameLength = view.getUint32(offset, false)
      offset += 4
      const name = textDecoder.decode(transcript.slice(offset, offset + nameLength))
      offset += nameLength
      const valueLength = view.getUint32(offset, false)
      offset += 4
      if (fields.has(name) || offset + valueLength > transcript.byteLength) {
        return null
      }
      fields.set(name, transcript.slice(offset, offset + valueLength))
      offset += valueLength
    }
  } catch {
    return null
  }
  return offset === transcript.byteLength ? fields : null
}

function readUint64(value: Uint8Array | undefined): number | null {
  if (!value || value.byteLength !== 8) {
    return null
  }
  const parsed = new DataView(value.buffer, value.byteOffset, value.byteLength).getBigUint64(
    0,
    false
  )
  return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : null
}

function validateTranscript(
  transcript: Uint8Array,
  challenge: RelayHostChallenge,
  context: RelayHostProofContext,
  relayKey: Uint8Array,
  nonce: Uint8Array
): boolean {
  const fields = parseTranscript(transcript)
  if (!fields || fields.size !== 16) {
    return false
  }
  const now = (context.now ?? Date.now)()
  const issuedAt = readUint64(fields.get('issuedAt'))
  const expiresAt = readUint64(fields.get('expiresAt'))
  const previousGeneration = fields.get('previousGeneration')
  const expectedPrevious =
    context.previousGeneration === undefined ? new Uint8Array() : uint64(context.previousGeneration)
  return (
    issuedAt !== null &&
    issuedAt <= now &&
    now <= challenge.expiresAt &&
    challenge.expiresAt - issuedAt <= 10_000 &&
    expiresAt === challenge.expiresAt &&
    equal(fields.get('protocol'), textEncoder.encode(HOST_PROOF_TRANSCRIPT_DOMAIN)) &&
    equal(fields.get('version'), new Uint8Array([1])) &&
    equal(fields.get('relayOrigin'), textEncoder.encode(context.relayOrigin)) &&
    equal(fields.get('relayEphemeralPublicKey'), relayKey) &&
    equal(fields.get('challengeNonce'), nonce) &&
    equal(fields.get('challengeId'), textEncoder.encode(challenge.challengeId)) &&
    equal(fields.get('userId'), textEncoder.encode(context.userId)) &&
    equal(fields.get('profileId'), textEncoder.encode(context.profileId)) &&
    equal(fields.get('organizationId'), textEncoder.encode(context.organizationId)) &&
    equal(fields.get('relayHostId'), textEncoder.encode(context.relayHostId)) &&
    equal(fields.get('hostPublicKey'), context.hostPublicKey) &&
    equal(fields.get('assignmentEpoch'), uint64(context.assignmentEpoch)) &&
    equal(previousGeneration, expectedPrevious) &&
    equal(fields.get('resumeRequested'), new Uint8Array([context.resumeRequested ? 1 : 0]))
  )
}

export function answerRelayHostChallenge(
  challenge: RelayHostChallenge,
  context: RelayHostProofContext
): string | null {
  const relayKey = decodeCanonicalBase64(challenge.relayEphemeralPublicKeyB64, 32)
  const nonce = decodeCanonicalBase64(challenge.nonceB64, 24)
  const ciphertext = Buffer.from(challenge.ciphertextB64, 'base64')
  if (!relayKey || !nonce || ciphertext.toString('base64') !== challenge.ciphertextB64) {
    return null
  }
  const plaintext = nacl.box.open(ciphertext, nonce, relayKey, context.hostSecretKey)
  if (!plaintext) {
    return null
  }
  const domain = textEncoder.encode(`${HOST_CHALLENGE_PLAINTEXT_DOMAIN}\0`)
  if (
    !equal(plaintext.slice(0, domain.byteLength), domain) ||
    plaintext.byteLength < domain.byteLength + 36
  ) {
    return null
  }
  const transcriptLength = new DataView(
    plaintext.buffer,
    plaintext.byteOffset + domain.byteLength,
    4
  ).getUint32(0, false)
  const transcriptStart = domain.byteLength + 4
  const secretStart = transcriptStart + transcriptLength
  if (secretStart + 32 !== plaintext.byteLength) {
    return null
  }
  const transcript = plaintext.slice(transcriptStart, secretStart)
  if (!validateTranscript(transcript, challenge, context, relayKey, nonce)) {
    return null
  }
  const secret = plaintext.slice(secretStart)
  return createHmac('sha256', secret)
    .update(textEncoder.encode(`${HOST_PROOF_TRANSCRIPT_DOMAIN}\0ack\0`))
    .update(transcript)
    .digest('base64')
}
