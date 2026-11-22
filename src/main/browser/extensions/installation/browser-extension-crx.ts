import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto'

/**
 * CRX3 parsing and signature verification, following Chromium's components/crx_file/crx_verifier.cc.
 * Layout: "Cr24" | uint32 version (3) | uint32 header size | CrxFileHeader protobuf | zip archive.
 */

const CRX_MAGIC = 'Cr24'
const SIGNED_DATA_PREFIX = Buffer.from('CRX3 SignedData\x00', 'latin1')
const MAX_HEADER_BYTES = 256 * 1024
// SHA-256 of the Chrome Web Store publisher key; every store CRX carries a proof made with it.
const WEB_STORE_PUBLISHER_KEY_HASH =
  '61f7f2a6bfcf74cd0bc1fe2497cc9b04254c658f79f2145392867ea8366367cf'

// CrxFileHeader / AsymmetricKeyProof / SignedData field numbers (crx3.proto).
const HEADER_SHA256_WITH_RSA = 2
const HEADER_SHA256_WITH_ECDSA = 3
const HEADER_SIGNED_HEADER_DATA = 10000
const PROOF_PUBLIC_KEY = 1
const PROOF_SIGNATURE = 2
const SIGNED_DATA_CRX_ID = 1

export type VerifiedCrx = {
  extensionId: string
  /** DER SubjectPublicKeyInfo of the developer key; written to manifest.key so Electron derives the same id. */
  publicKey: Buffer
  archive: Buffer
}

type Proof = { algorithm: 'rsa' | 'ecdsa'; publicKey: Buffer; signature: Buffer }

/** Chromium's id: first 16 bytes of SHA-256(key) in hex, with digits 0-f mapped to letters a-p. */
export function extensionIdFromHash(hash: Buffer): string {
  return [...hash.subarray(0, 16).toString('hex')]
    .map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
    .join('')
}

export function extensionIdFromPublicKey(publicKeyDer: Buffer): string {
  return extensionIdFromHash(createHash('sha256').update(publicKeyDer).digest())
}

function readVarint(buffer: Buffer, start: number): { value: number; next: number } {
  let value = 0
  let multiplier = 1
  for (let offset = start; offset < buffer.length && offset < start + 8; offset++) {
    const byte = buffer[offset]
    value += (byte & 0x7f) * multiplier
    if ((byte & 0x80) === 0) {
      return { value, next: offset + 1 }
    }
    multiplier *= 128
  }
  throw new Error('Malformed CRX header')
}

/** Length-delimited fields of one protobuf message; other wire types are skipped. */
function readMessageFields(buffer: Buffer): { field: number; bytes: Buffer }[] {
  const fields: { field: number; bytes: Buffer }[] = []
  let offset = 0
  while (offset < buffer.length) {
    const key = readVarint(buffer, offset)
    const field = Math.floor(key.value / 8)
    const wireType = key.value % 8
    offset = key.next
    if (wireType === 0) {
      offset = readVarint(buffer, offset).next
    } else if (wireType === 1) {
      offset += 8
    } else if (wireType === 5) {
      offset += 4
    } else if (wireType === 2) {
      const length = readVarint(buffer, offset)
      const end = length.next + length.value
      if (end > buffer.length) {
        throw new Error('Malformed CRX header')
      }
      fields.push({ field, bytes: buffer.subarray(length.next, end) })
      offset = end
    } else {
      throw new Error('Malformed CRX header')
    }
    if (offset > buffer.length) {
      throw new Error('Malformed CRX header')
    }
  }
  return fields
}

function readProof(algorithm: Proof['algorithm'], bytes: Buffer): Proof {
  const fields = readMessageFields(bytes)
  const publicKey = fields.find((entry) => entry.field === PROOF_PUBLIC_KEY)?.bytes
  const signature = fields.find((entry) => entry.field === PROOF_SIGNATURE)?.bytes
  if (!publicKey || !signature) {
    throw new Error('CRX signature is incomplete')
  }
  return { algorithm, publicKey, signature }
}

function importKey(proof: Proof): KeyObject {
  let key: KeyObject
  try {
    key = createPublicKey({ key: proof.publicKey, format: 'der', type: 'spki' })
  } catch {
    throw new Error('CRX signature has an unreadable key')
  }
  const expectedType = proof.algorithm === 'rsa' ? 'rsa' : 'ec'
  if (key.asymmetricKeyType !== expectedType) {
    throw new Error('CRX signature key does not match its algorithm')
  }
  return key
}

/**
 * Parses a CRX3 and checks it the way Chrome does before installing: every proof must verify over
 * the signed data, one proof's key must hash to the declared id, and (for store installs) one proof
 * must come from the Chrome Web Store publisher key.
 */
export function verifyCrx3(
  buffer: Buffer,
  options: { expectedExtensionId: string; requirePublisherProof: boolean }
): VerifiedCrx {
  if (buffer.length < 12 || buffer.toString('latin1', 0, 4) !== CRX_MAGIC) {
    throw new Error('Not a CRX file')
  }
  if (buffer.readUInt32LE(4) !== 3) {
    throw new Error('Only CRX3 packages are supported')
  }
  const headerSize = buffer.readUInt32LE(8)
  if (headerSize > MAX_HEADER_BYTES || 12 + headerSize >= buffer.length) {
    throw new Error('Malformed CRX header')
  }
  const header = buffer.subarray(12, 12 + headerSize)
  const archive = buffer.subarray(12 + headerSize)

  const proofs: Proof[] = []
  let signedHeaderData: Buffer | null = null
  for (const { field, bytes } of readMessageFields(header)) {
    if (field === HEADER_SHA256_WITH_RSA) {
      proofs.push(readProof('rsa', bytes))
    } else if (field === HEADER_SHA256_WITH_ECDSA) {
      proofs.push(readProof('ecdsa', bytes))
    } else if (field === HEADER_SIGNED_HEADER_DATA) {
      signedHeaderData = bytes
    }
  }
  const crxIdBytes = signedHeaderData
    ? readMessageFields(signedHeaderData).find((entry) => entry.field === SIGNED_DATA_CRX_ID)?.bytes
    : undefined
  if (!signedHeaderData || crxIdBytes?.length !== 16) {
    throw new Error('CRX has no signed id')
  }
  const declaredId = extensionIdFromHash(crxIdBytes)
  if (declaredId !== options.expectedExtensionId) {
    throw new Error('CRX belongs to a different extension')
  }
  if (proofs.length === 0) {
    throw new Error('CRX is not signed')
  }

  const signedHeaderLength = Buffer.alloc(4)
  signedHeaderLength.writeUInt32LE(signedHeaderData.length)
  const signedData = Buffer.concat([
    SIGNED_DATA_PREFIX,
    signedHeaderLength,
    signedHeaderData,
    archive
  ])

  let developerKey: Buffer | null = null
  let hasPublisherProof = false
  for (const proof of proofs) {
    if (!verify('sha256', signedData, importKey(proof), proof.signature)) {
      throw new Error('CRX signature does not verify')
    }
    const keyHash = createHash('sha256').update(proof.publicKey).digest()
    if (extensionIdFromHash(keyHash) === declaredId) {
      developerKey = proof.publicKey
    }
    if (keyHash.toString('hex') === WEB_STORE_PUBLISHER_KEY_HASH) {
      hasPublisherProof = true
    }
  }
  if (!developerKey) {
    throw new Error('CRX is not signed by its own key')
  }
  if (options.requirePublisherProof && !hasPublisherProof) {
    throw new Error('CRX is not signed by the Chrome Web Store')
  }
  return { extensionId: declaredId, publicKey: developerKey, archive }
}
