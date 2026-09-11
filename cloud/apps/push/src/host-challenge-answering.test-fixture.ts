import { createHmac, timingSafeEqual } from 'node:crypto'
import {
  PUSH_HOST_CHALLENGE_PLAINTEXT_DOMAIN,
  PUSH_HOST_PROOF_TRANSCRIPT_DOMAIN,
  PUSH_HOST_PROOF_TRANSCRIPT_FIELD_COUNT,
  PUSH_LIMITS
} from '@orca-cloud/push-contract'
import nacl from 'tweetnacl'
import { decodeCanonicalBase64 } from './canonical-base64.js'
import { deriveHostFingerprint } from './host-fingerprint.js'

// The desktop side of the push challenge, written the way the shipped host
// will answer it, so the gateway is exercised against a real box-opening peer.
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export type PushHostKeypair = { publicKey: Uint8Array; secretKey: Uint8Array }

export type PushChallengeWire = {
  challengeId: string
  gatewayEphemeralPublicKeyB64: string
  nonceB64: string
  ciphertextB64: string
  expiresAt: number
}

export function createPushHostKeypair(seed?: number): PushHostKeypair {
  const pair =
    seed === undefined
      ? nacl.box.keyPair()
      : nacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(seed))
  return { publicKey: pair.publicKey, secretKey: pair.secretKey }
}

export function hostPublicKeyB64(keypair: PushHostKeypair): string {
  return Buffer.from(keypair.publicKey).toString('base64')
}

function equal(left: Uint8Array | undefined, right: Uint8Array): boolean {
  return Boolean(left && left.byteLength === right.byteLength && timingSafeEqual(left, right))
}

function uint64(value: number): Uint8Array {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false)
  return bytes
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
      if (fields.has(name) || offset + valueLength > transcript.byteLength) return null
      fields.set(name, transcript.slice(offset, offset + valueLength))
      offset += valueLength
    }
  } catch {
    return null
  }
  return offset === transcript.byteLength ? fields : null
}

function readUint64(value: Uint8Array | undefined): number | null {
  if (!value || value.byteLength !== 8) return null
  const parsed = new DataView(value.buffer, value.byteOffset, value.byteLength).getBigUint64(0, false)
  return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : null
}

export type PushHostProofContext = {
  gatewayOrigin: string
  keypair: PushHostKeypair
  now?: () => number
  onInvalid?: (reason: string) => void
}

function validateTranscript(
  transcript: Uint8Array,
  challenge: PushChallengeWire,
  context: PushHostProofContext,
  gatewayKey: Uint8Array,
  nonce: Uint8Array
): boolean {
  const fields = parseTranscript(transcript)
  if (!fields || fields.size !== PUSH_HOST_PROOF_TRANSCRIPT_FIELD_COUNT) {
    context.onInvalid?.('transcript-structure')
    return false
  }
  const now = (context.now ?? Date.now)()
  const issuedAt = readUint64(fields.get('issuedAt'))
  const expiresAt = readUint64(fields.get('expiresAt'))
  const fingerprint = deriveHostFingerprint(context.keypair.publicKey)
  const checks: [string, boolean][] = [
    ['issuedAt-readable', issuedAt !== null],
    [
      'issuedAt-not-future',
      issuedAt === null || issuedAt - PUSH_LIMITS.clockSkewToleranceMs <= now
    ],
    ['not-expired', now - PUSH_LIMITS.clockSkewToleranceMs <= challenge.expiresAt],
    ['issuedAt-before-expiry', issuedAt === null || issuedAt <= challenge.expiresAt],
    [
      'window',
      issuedAt === null || challenge.expiresAt - issuedAt <= PUSH_LIMITS.challengeTtlMs
    ],
    ['expiry-consistent', expiresAt === challenge.expiresAt],
    ['protocol', equal(fields.get('protocol'), textEncoder.encode(PUSH_HOST_PROOF_TRANSCRIPT_DOMAIN))],
    ['version', equal(fields.get('version'), new Uint8Array([1]))],
    ['gatewayOrigin', equal(fields.get('gatewayOrigin'), textEncoder.encode(context.gatewayOrigin))],
    ['gatewayEphemeralPublicKey', equal(fields.get('gatewayEphemeralPublicKey'), gatewayKey)],
    ['challengeNonce', equal(fields.get('challengeNonce'), nonce)],
    ['challengeId', equal(fields.get('challengeId'), textEncoder.encode(challenge.challengeId))],
    ['hostFingerprint', equal(fields.get('hostFingerprint'), textEncoder.encode(fingerprint))],
    ['hostPublicKey', equal(fields.get('hostPublicKey'), context.keypair.publicKey)],
    ['issuedAt-value', issuedAt === null || uint64(issuedAt).byteLength === 8]
  ]
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name)
  if (failed.length === 0) return true
  context.onInvalid?.(`transcript:${failed.join('+')}`)
  return false
}

export function answerPushHostChallenge(
  challenge: PushChallengeWire,
  context: PushHostProofContext
): string | null {
  const gatewayKey = decodeCanonicalBase64(challenge.gatewayEphemeralPublicKeyB64, 32)
  const nonce = decodeCanonicalBase64(challenge.nonceB64, 24)
  const ciphertext = Buffer.from(challenge.ciphertextB64, 'base64')
  if (!gatewayKey || !nonce || ciphertext.toString('base64') !== challenge.ciphertextB64) return null
  const plaintext = nacl.box.open(ciphertext, nonce, gatewayKey, context.keypair.secretKey)
  if (!plaintext) {
    context.onInvalid?.('challenge-box-open')
    return null
  }
  const domain = textEncoder.encode(`${PUSH_HOST_CHALLENGE_PLAINTEXT_DOMAIN}\0`)
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
  if (secretStart + 32 !== plaintext.byteLength) return null
  const transcript = plaintext.slice(transcriptStart, secretStart)
  if (!validateTranscript(transcript, challenge, context, gatewayKey, nonce)) return null
  return createHmac('sha256', plaintext.slice(secretStart))
    .update(textEncoder.encode(`${PUSH_HOST_PROOF_TRANSCRIPT_DOMAIN}\0ack\0`))
    .update(transcript)
    .digest('base64')
}
