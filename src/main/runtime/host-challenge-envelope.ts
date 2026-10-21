// Why: the relay and the push gateway both authenticate this host with the same
// sealed-box challenge shape (the host keypair is X25519, so it cannot sign).
// Only the domain strings and the transcript fields differ, so the envelope
// handling lives here and each protocol owns its own field validation.
import { createHmac, timingSafeEqual } from 'node:crypto'
import nacl from 'tweetnacl'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

export function decodeCanonicalBase64(value: string, expectedBytes: number): Uint8Array | null {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return null
  }
  const decoded = Buffer.from(value, 'base64')
  return decoded.byteLength === expectedBytes && decoded.toString('base64') === value
    ? decoded
    : null
}

export function encodeUint64(value: number): Uint8Array {
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setBigUint64(0, BigInt(value), false)
  return bytes
}

export function equalBytes(left: Uint8Array | undefined, right: Uint8Array): boolean {
  return Boolean(left && left.byteLength === right.byteLength && timingSafeEqual(left, right))
}

export function encodeText(value: string): Uint8Array {
  return textEncoder.encode(value)
}

/** Length-prefixed field map: u32be(len(name)) || name || u32be(len(value)) || value. */
export function parseHostChallengeTranscript(
  transcript: Uint8Array
): Map<string, Uint8Array> | null {
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

export function readTranscriptUint64(value: Uint8Array | undefined): number | null {
  if (!value || value.byteLength !== 8) {
    return null
  }
  const parsed = new DataView(value.buffer, value.byteOffset, value.byteLength).getBigUint64(
    0,
    false
  )
  return parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(parsed) : null
}

export type HostChallengeEnvelope = {
  transcript: Uint8Array
  secret: Uint8Array
  peerEphemeralPublicKey: Uint8Array
  nonce: Uint8Array
}

/**
 * Opens the sealed challenge and splits out the transcript and the 32-byte secret.
 * Returns null for any malformed or undecryptable challenge; the caller still has
 * to validate the transcript's fields before answering.
 */
export function openHostChallengeEnvelope(input: {
  peerEphemeralPublicKeyB64: string
  nonceB64: string
  ciphertextB64: string
  hostSecretKey: Uint8Array
  plaintextDomain: string
  /** Reports the failing check by name only; never receives field values. */
  onInvalid?: (reason: string) => void
}): HostChallengeEnvelope | null {
  const peerKey = decodeCanonicalBase64(input.peerEphemeralPublicKeyB64, 32)
  const nonce = decodeCanonicalBase64(input.nonceB64, 24)
  const ciphertext = Buffer.from(input.ciphertextB64, 'base64')
  if (!peerKey || !nonce || ciphertext.toString('base64') !== input.ciphertextB64) {
    return null
  }
  const plaintext = nacl.box.open(ciphertext, nonce, peerKey, input.hostSecretKey)
  if (!plaintext) {
    input.onInvalid?.('challenge-box-open')
    return null
  }
  const domain = textEncoder.encode(`${input.plaintextDomain}\0`)
  if (
    !equalBytes(plaintext.slice(0, domain.byteLength), domain) ||
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
  return {
    transcript: plaintext.slice(transcriptStart, secretStart),
    secret: plaintext.slice(secretStart),
    peerEphemeralPublicKey: peerKey,
    nonce
  }
}

export function hostChallengeAckProof(input: {
  secret: Uint8Array
  transcript: Uint8Array
  proofDomain: string
}): string {
  return createHmac('sha256', input.secret)
    .update(textEncoder.encode(`${input.proofDomain}\0ack\0`))
    .update(input.transcript)
    .digest('base64')
}
